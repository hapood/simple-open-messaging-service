import { signal } from "@angular/core"

export function arrayToDictIndex<T extends string, U>(arr: (Record<T, string> & U)[], key: T) {
  const dict = {} as Record<string, U>
  arr.forEach(item => {
    dict[key] = item
  })
  return dict
}

interface ArraySignal<T> {
  (): T[];
  push: (item: T) => void;
  set(arr: T[]): void;
  filter<S extends T>(predicate: (value: T, index: number, array: T[]) => value is S, thisArg?: any): void;
  filter(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: any): void;
}

export function arraySignal<T>(arr: T[]): ArraySignal<T> {
  const _signal = signal(arr)
  return Object.assign(
    () => _signal(),
    {
      set: (arr: T[]) => { _signal.set(arr) },
      push: (item: T) => _signal.update(arr => arr.concat(item)),
      filter: ((predicate: any, thisArg?: any) => {
        return _signal.set(_signal().filter(predicate, thisArg))
      })
    }
  )
}

type RecordKey = string | number | symbol

interface RecordSignal<T> {
  (): Record<RecordKey, T>;
  set(key: RecordKey, value: T): void;
}
export function recordSignal<T>(record: Record<RecordKey, T>): RecordSignal<T> {
  const _signal = signal(record)
  return Object.assign(
    () => _signal(),
    {
      set: (key: RecordKey, value: T) => { _signal.set({ ..._signal(), [key]: value }) },
    }
  )
}