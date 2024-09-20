export function arrayToDictIndex<T extends string, U>(arr: (Record<T, string> & U)[], key: T) {
  const dict = {} as Record<string, U>
  arr.forEach(item => {
    dict[key] = item
  })
  return dict
}