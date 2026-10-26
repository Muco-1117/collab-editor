export function createLatestRequestGate() {
  let generation = 0

  return {
    begin() {
      generation += 1
      return generation
    },
    invalidate() {
      generation += 1
    },
    isCurrent(request) {
      return request === generation
    },
  }
}
