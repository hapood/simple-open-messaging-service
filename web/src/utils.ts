export function arrayToDictIndex<T extends string, U>(arr: (Record<T, string | number> & U)[], key: T) {
  const dict = {} as Record<string | number, U>
  arr.forEach(item => {
    dict[item[key]] = item
  })
  return dict
}