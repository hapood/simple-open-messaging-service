export interface MessageContextMenuPoint {
  x: number;
  y: number;
}

export interface MessageContextMenuBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function positionMessageContextMenu(
  anchor: MessageContextMenuPoint,
  bounds: MessageContextMenuBounds,
  size: { width: number; height: number },
  inset: number,
): MessageContextMenuPoint {
  const minX = bounds.left + inset;
  const minY = bounds.top + inset;
  const maxX = Math.max(minX, bounds.right - inset - size.width);
  const maxY = Math.max(minY, bounds.bottom - inset - size.height);
  const preferredX =
    anchor.x + size.width <= bounds.right - inset
      ? anchor.x
      : anchor.x - size.width;
  const preferredY =
    anchor.y + size.height <= bounds.bottom - inset
      ? anchor.y
      : anchor.y - size.height;
  return {
    x: Math.min(maxX, Math.max(minX, preferredX)),
    y: Math.min(maxY, Math.max(minY, preferredY)),
  };
}
