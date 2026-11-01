import type { CSSProperties } from 'react'
import { PICTURES } from './pictures'

// Replaces src/components/QuestionPicture in the demo, where the game server's picture route is
// the matching drawing: the path is /live-image/<question index>.
export default function QuestionPicture({ path, maxHeight, style }: { path: string; maxHeight: string; style?: CSSProperties }) {
  const index = Number(path.match(/live-image\/(-?\d+)/)?.[1])
  return (
    <img
      src={PICTURES[index]}
      alt="Question picture"
      style={{ display: 'block', maxWidth: '100%', maxHeight, width: 'auto', margin: '0 auto', objectFit: 'contain', borderRadius: 'var(--radius)', ...style }}
    />
  )
}
