export function canBorrow(activeReservations: number, stars: number): boolean {
  return activeReservations < stars;
}

export function ratingDelta(
  isLate: boolean,
  conditionUnchanged: boolean,
): number {
  if (isLate || !conditionUnchanged) {
    return -10 * (Number(isLate) + Number(!conditionUnchanged));
  }
  return 1;
}
