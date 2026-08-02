/** Chat pagination status UI. Deliberately independent from the realtime/SSE connection indicator. */
export function createChatEdgeStatus(): HTMLElement {
  const status = document.createElement('span');
  status.className = 'cb-load-status';
  status.setAttribute('aria-hidden', 'true');

  const ns = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(ns, 'svg');
  icon.classList.add('cb-load-icon');
  icon.setAttribute('viewBox', '0 0 24 24');

  const spinner = document.createElementNS(ns, 'g');
  spinner.classList.add('cb-load-icon__spinner');
  const track = document.createElementNS(ns, 'circle');
  track.classList.add('cb-load-icon__track');
  const arc = document.createElementNS(ns, 'circle');
  arc.classList.add('cb-load-icon__arc');
  for (const circle of [track, arc]) {
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '8.5');
  }
  spinner.append(track, arc);
  icon.appendChild(spinner);

  const retry = document.createElementNS(ns, 'path');
  retry.classList.add('cb-load-icon__retry');
  retry.setAttribute(
    'd',
    'M20 11a8 8 0 0 0-14.93-4M4 4v4h4M4 13a8 8 0 0 0 14.93 4M20 20v-4h-4',
  );
  icon.appendChild(retry);
  status.appendChild(icon);

  return status;
}
