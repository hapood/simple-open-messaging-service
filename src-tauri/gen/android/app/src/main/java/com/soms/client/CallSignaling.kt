package com.soms.client

/** Endpoint-only SDP inspection. Signaling bodies are never rewritten. */
internal object CallSignaling {
    private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private val iceUfrag = Regex("[A-Za-z0-9+/]{4,256}")
    fun validIceUfrag(value: String): Boolean = iceUfrag.matches(value)
    fun canonicalId(value: String): Boolean = uuid.matches(value)
    fun validReference(kind: String, present: Boolean, reference: String): Boolean =
        if (kind == "answer") present && canonicalId(reference) else !present

    data class Offer(val id: String, val sdp: String)

    enum class AnswerDecision { APPLY, IGNORE, CONFLICT }

    /** Executor-confined caller offer lane; admission is not SDP completion. */
    class OfferLane {
        var activeId: String? = null
            private set
        var applying = false
            private set
        private val completed = HashSet<String>()
        fun begin(id: String): Boolean {
            if (!canonicalId(id) || activeId != null) return false
            activeId = id
            return true
        }
        fun beginAnswer(reply: String, haveLocalOffer: Boolean): AnswerDecision {
            if (!canonicalId(reply)) return AnswerDecision.CONFLICT
            if (reply in completed) return AnswerDecision.IGNORE
            if (reply != activeId) return AnswerDecision.CONFLICT
            if (applying) return AnswerDecision.IGNORE
            if (!haveLocalOffer) return AnswerDecision.CONFLICT
            applying = true
            return AnswerDecision.APPLY
        }
        fun complete(id: String): Boolean {
            if (activeId != id || !applying) return false
            completed.add(id)
            activeId = null
            applying = false
            return true
        }
        fun reset() { activeId = null; applying = false; completed.clear() }
    }
    data class Section(val mid: String?, val ufrag: String?, val kind: String,
                       val active: Boolean, val direction: String)

    fun sections(sdp: String): List<Section> {
        val lines = sdp.lineSequence().map { it.trimEnd('\r') }.toList()
        val session = lines.takeWhile { !it.startsWith("m=") }
        val sessionUfrag = session.firstOrNull { it.startsWith("a=ice-ufrag:") }?.substringAfter(':')
        val sessionDirection = session.firstOrNull { it in directions }?.removePrefix("a=") ?: "sendrecv"
        val groups = mutableListOf<MutableList<String>>()
        for (line in lines.drop(session.size)) {
            if (line.startsWith("m=")) groups.add(mutableListOf())
            groups.lastOrNull()?.add(line)
        }
        val sections = groups.map { group ->
            val media = group.first().removePrefix("m=").split(' ')
            Section(group.firstOrNull { it.startsWith("a=mid:") }?.substringAfter(':'),
                group.firstOrNull { it.startsWith("a=ice-ufrag:") }?.substringAfter(':') ?: sessionUfrag,
                media.first(), media.getOrNull(1) != "0",
                group.firstOrNull { it in directions }?.removePrefix("a=") ?: sessionDirection)
        }
        // A bundled section can inherit the bundle transport's credentials.
        val bundle = session.firstOrNull { it.startsWith("a=group:BUNDLE ") }
            ?.substringAfter("BUNDLE ")?.split(' ') ?: emptyList()
        val transport = sections.firstOrNull { it.mid == bundle.firstOrNull() }?.ufrag
        return sections.map { if (it.ufrag == null && it.mid in bundle) it.copy(ufrag = transport) else it }
    }

    private val directions = setOf("a=sendrecv", "a=sendonly", "a=recvonly", "a=inactive")

    fun section(sections: List<Section>, mid: String?, index: Int): Section? {
        val byMid = mid?.let { value -> sections.firstOrNull { it.mid == value } }
        val byIndex = sections.getOrNull(index)
        if (mid != null && byMid == null) return null
        if (byMid != null && byIndex != null && byMid != byIndex) return null
        return byMid ?: byIndex
    }

    enum class IceDecision { APPLY, BUFFER, DROP }
    fun remoteIce(sections: List<Section>, obsolete: Set<String>, ufrag: String?,
                  mid: String?, index: Int): IceDecision {
        if (ufrag.isNullOrBlank()) return IceDecision.DROP
        if (section(sections, mid, index)?.ufrag == ufrag) return IceDecision.APPLY
        return if (ufrag in obsolete) IceDecision.DROP else IceDecision.BUFFER
    }

    fun candidateUfrag(candidate: String): String? {
        val words = candidate.split(Regex("\\s+"))
        val index = words.indexOf("ufrag")
        return if (index >= 0) words.getOrNull(index + 1)?.takeIf { it.isNotBlank() } else null
    }

    /** Native callbacks have no ufrag property. Never substitute current credentials after a restart.
     * Candidate extensions disambiguate; otherwise only a single
     * observed generation for that transport is safe. Called at callback receipt, before executor delay. */
    data class GatheredCandidate(val candidate: String, val mid: String?, val index: Int, val ufrag: String)

    class LocalIce {
        private val sent = LinkedHashSet<String>()
        @Synchronized fun claim(candidate: String, mid: String?, index: Int, ufrag: String): Boolean {
            val key = listOf(ufrag, mid ?: "", index.toString(), candidate).joinToString("\u0000")
            if (!sent.add(key)) return false
            if (sent.size > 512) sent.remove(sent.first())
            return true
        }

        /** A native local description associates candidates with its own credentials.
         * This is authoritative even when a candidate callback has no ufrag extension. */
        fun gathered(sdp: String): List<GatheredCandidate> {
            val candidateSections = mutableListOf<MutableList<String>>()
            for (line in sdp.lineSequence().map { it.trimEnd('\r') }) {
                if (line.startsWith("m=")) candidateSections.add(mutableListOf())
                if (line.startsWith("a=candidate:")) candidateSections.lastOrNull()?.add(line.removePrefix("a="))
            }
            return CallSignaling.sections(sdp).flatMapIndexed { index, section ->
                val ufrag = section.ufrag?.takeIf { validIceUfrag(it) }
                    ?: return@flatMapIndexed emptyList<GatheredCandidate>()
                (candidateSections.getOrNull(index) ?: emptyList()).mapNotNull { candidate ->
                    val embedded = candidateUfrag(candidate)
                    if (embedded != null && embedded != ufrag) null
                    else GatheredCandidate(candidate, section.mid, index, ufrag)
                }
            }
        }

        private val history = mutableListOf<List<Section>>()
        private var exhausted = false
        @Synchronized fun remember(sdp: String) {
            // Keep only section identity and generation credentials, not gathering or media changes.
            val credentials = sections(sdp).map { it.copy(kind = "", active = true, direction = "") }
            if (credentials !in history) {
                if (history.size >= 32) exhausted = true else history.add(credentials)
            }
        }
        @Synchronized fun identify(candidate: String, mid: String?, index: Int): String? {
            if (exhausted) return null
            candidateUfrag(candidate)?.let { explicit ->
                return explicit.takeIf { value -> history.any { section(it, mid, index)?.ufrag == value } }
            }
            val matching = history.mapNotNull { section(it, mid, index) }
            // Candidate addresses can be reused across restarts: SDP membership alone is not proof.
            val generations = matching.mapNotNull { it.ufrag }.toSet()
            return generations.singleOrNull()?.takeIf { it.isNotBlank() }
        }
    }

    fun videoNegotiated(local: String, remote: String, sending: Boolean, receiving: Boolean): Boolean {
        val localSections = sections(local)
        val remoteSections = sections(remote)
        return localSections.withIndex().any { (index, ours) ->
            val theirs = section(remoteSections, ours.mid, index) ?: return@any false
            ours.kind == "video" && theirs.kind == "video" && ours.active && theirs.active &&
                ours.direction != "inactive" && theirs.direction != "inactive" &&
                (!sending || (ours.direction in setOf("sendrecv", "sendonly") &&
                    theirs.direction in setOf("sendrecv", "recvonly"))) &&
                (!receiving || (ours.direction in setOf("sendrecv", "recvonly") &&
                    theirs.direction in setOf("sendrecv", "sendonly")))
        }
    }
}
