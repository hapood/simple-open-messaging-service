import { federationLabNodeForDomain, federationLabNodes } from '../topology.mjs';

function directionKey(author, subject) {
  if (author === subject) throw new Error('an intent requires two users');
  return `${author}->${subject}`;
}

function addressDomain(address) {
  return address.slice(address.lastIndexOf('@') + 1);
}

function nodeForAddress(address) {
  const domain = addressDomain(address);
  return federationLabNodeForDomain(domain);
}

function effectiveRequest(intent, observedAt) {
  if (intent?.status !== 'REQUESTED') return false;
  if (!intent.expiresAt) return false;
  return Date.parse(intent.expiresAt) > Date.parse(observedAt);
}

export function observeDirectedPair(snapshot, selectedAuthor, selectedSubject) {
  const pair =
    selectedAuthor < selectedSubject
      ? `${selectedAuthor}|${selectedSubject}`
      : `${selectedSubject}|${selectedAuthor}`;
  const observer = nodeForAddress(selectedAuthor);
  const nodeSnapshot = snapshot[observer.name];
  if (!nodeSnapshot)
    throw new Error(`snapshot is missing node ${observer.name}`);
  // Decisions must reflect the actor's local view, not a merge of remote authorities.
  const intents = new Map(
    nodeSnapshot.intents.directions.map((intent) => [
      directionKey(intent.author, intent.subject),
      intent,
    ]),
  );
  const observedAt = new Date().toISOString();
  const outgoing = intents.get(directionKey(selectedAuthor, selectedSubject));
  const incoming = intents.get(directionKey(selectedSubject, selectedAuthor));
  const pairExists = nodeSnapshot.pairs.all.includes(pair);
  const pairActive = nodeSnapshot.pairs.active.includes(pair);
  let state = 'NONE';
  if (pairActive) state = 'FRIEND';
  else if (effectiveRequest(outgoing, observedAt)) state = 'OUTGOING_PENDING';
  else if (effectiveRequest(incoming, observedAt)) state = 'INCOMING_PENDING';
  return {
    state,
    observedAt,
    observedOn: observer.name,
    pairExists,
    pairActive,
    threadId: nodeSnapshot.pairs.threadIds?.[pair] ?? null,
    outgoingIntent: outgoing?.status ?? null,
    incomingIntent: incoming?.status ?? null,
  };
}
