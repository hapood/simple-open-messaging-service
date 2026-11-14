package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

class BackupPolicyTest {
    private val domains = setOf(
        "root", "file", "database", "sharedpref", "external",
        "device_root", "device_file", "device_database", "device_sharedpref",
    )

    private fun document(path: String) = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
    }.newDocumentBuilder().parse(File("src/main/$path"))

    @Test
    fun manifestDisablesBackupAndReferencesBothPolicies() {
        val app = document("AndroidManifest.xml").getElementsByTagName("application").item(0) as Element
        val namespace = "http://schemas.android.com/apk/res/android"
        assertEquals("false", app.getAttributeNS(namespace, "allowBackup"))
        assertEquals("@xml/backup_rules", app.getAttributeNS(namespace, "fullBackupContent"))
        assertEquals("@xml/data_extraction_rules", app.getAttributeNS(namespace, "dataExtractionRules"))
    }

    @Test
    fun everyStorageDomainIsExcludedFromLegacyCloudAndDeviceTransfer() {
        val legacy = document("res/xml/backup_rules.xml").documentElement
        val modern = document("res/xml/data_extraction_rules.xml")
        for (policy in listOf(
            legacy,
            modern.getElementsByTagName("cloud-backup").item(0) as Element,
            modern.getElementsByTagName("device-transfer").item(0) as Element,
        )) {
            assertEquals(0, policy.getElementsByTagName("include").length)
            val exclusions = policy.getElementsByTagName("exclude")
            assertEquals(domains.size, exclusions.length)
            val actualDomains = (0 until exclusions.length).map {
                val exclusion = exclusions.item(it) as Element
                assertEquals(".", exclusion.getAttribute("path"))
                exclusion.getAttribute("domain")
            }.toSet()
            assertEquals(domains, actualDomains)
        }
    }
}
