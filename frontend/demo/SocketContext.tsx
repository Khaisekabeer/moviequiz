// Replaces src/contexts/SocketContext in the demo: each screen gets its own recorded socket.
import { createContext, useContext, type ReactNode } from 'react'
import type { DemoSocket } from './runtime'

const SocketContext = createContext<any>(null)

export const ScreenSocket = ({ socket, children }: { socket: DemoSocket; children: ReactNode }) => (
  <SocketContext.Provider value={{ socket, isConnected: true, serverUrl: '' }}>{children}</SocketContext.Provider>
)

export const useSocket = () => useContext(SocketContext)
