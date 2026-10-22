/** Shared connection/retry status-ring geometry. Animation and palette are supplied by the host state. */
function createStatusRing(className = 'cb-edge-status-ring'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add(className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const group = document.createElementNS(ns, 'g');
  group.classList.add(`${className}__spin`);
  for (const part of ['track', 'arc']) {
    const circle = document.createElementNS(ns, 'circle');
    circle.classList.add(`${className}__${part}`);
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '9');
    circle.setAttribute('pathLength', '100');
    group.appendChild(circle);
  }
  svg.appendChild(group);
  return svg;
}

/** Compile-time Angular-template fragment for hosts that render extra states in the same SVG. */
export function statusRingTemplate(
  spinClass: string,
  trackClass: string,
  arcClass: string,
): string {
  return `<g class="${spinClass}">
    <circle class="${trackClass}" cx="12" cy="12" r="9" pathLength="100" />
    <circle class="${arcClass}" cx="12" cy="12" r="9" pathLength="100" />
  </g>`;
}
