import { useEffect, useState } from 'react'

const HOLD_AT = 4 // nobody is pressing Next on a timer here, so the clock stops short of zero

// Replaces src/hooks/useCountdown in the demo. The real one runs to 0, which would end the question.
export function useCountdown(endsAt: number | null | undefined, serverNow: number | null | undefined) {
  const [secondsLeft, setSecondsLeft] = useState(0)

  useEffect(() => {
    if (!endsAt) {
      setSecondsLeft(0)
      return
    }
    const offset = serverNow ? serverNow - Date.now() : 0
    const left = () => Math.ceil((endsAt - (Date.now() + offset)) / 1000)
    const floor = Math.min(HOLD_AT, left())
    const tick = () => setSecondsLeft(Math.max(floor, left()))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [endsAt, serverNow])

  return secondsLeft
}
