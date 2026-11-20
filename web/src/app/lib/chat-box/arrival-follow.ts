/** Following applies to a measured delivery, not to initial positioning or geometry repair. */
export function shouldFollowArrival(
  attached: boolean,
  addedHeight: number,
  viewportHeight: number,
): boolean {
  return attached && viewportHeight > 0 && addedHeight <= viewportHeight * 0.7;
}
