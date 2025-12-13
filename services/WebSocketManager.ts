import type { WSMessage } from '../types/jobs'

interface WebSocketLike {
  send(data: string | Buffer): void
  close(): void
}

class WebSocketManager {
  private connections: Map<string, Set<WebSocketLike>> = new Map()

  registerConnection(jobId: string, ws: WebSocketLike): void {
    if (!this.connections.has(jobId)) {
      this.connections.set(jobId, new Set())
    }

    this.connections.get(jobId)!.add(ws)
  }

  unregisterConnection(jobId: string, ws: WebSocketLike): void {
    const jobConnections = this.connections.get(jobId)
    if (!jobConnections) return

    jobConnections.delete(ws)

    if (jobConnections.size === 0) {
      this.connections.delete(jobId)
    }
  }

  broadcast(jobId: string, message: WSMessage): void {
    const jobConnections = this.connections.get(jobId)
    if (!jobConnections || jobConnections.size === 0) {
      return
    }

    const serialized = JSON.stringify(message)
    let sent = 0

    jobConnections.forEach(ws => {
      try {
        ws.send(serialized)
        sent++
      } catch (err) {
        console.error(`Failed to send to WS for job ${jobId}:`, err)
        jobConnections.delete(ws)
      }
    })
  }

  getConnectionCount(jobId: string): number {
    return this.connections.get(jobId)?.size || 0
  }

  getTotalConnections(): number {
    let total = 0
    this.connections.forEach(set => (total += set.size))
    return total
  }
}

export const wsManager = new WebSocketManager()
