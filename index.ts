import { Elysia } from 'elysia'
import path from 'path'
import axios from 'axios'
import JSONdb from 'simple-json-db'
import delay from 'delay'
import cliProgress from 'cli-progress'
import lodash from 'lodash'
import { spawn } from 'child_process'
import { wsManager } from './services/WebSocketManager'
import { jobStore } from './services/JobStore'
import { processLikedTracks } from './workers/LikedTracksWorker'
import { tryReorder } from './utils/spotify'
import type { Track } from './types/track'

interface SavedTrack {
  name: string
  lastTotal: number
}

let appUri = ''
const playlistDb = new JSONdb<SavedTrack>('./playlists.json', { jsonSpaces: 2 as unknown as boolean })
const apiUrl = 'https://api.spotify.com/v1'
const port = 4354

function startTunnel() {
  try {
    spawn('pkill', ['ngrok'], { stdio: 'ignore' })
  } catch {
    // Ignora erro se não houver processos para matar
  }

  const ngrok = spawn('ngrok', ['http', port.toString()], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  setTimeout(async () => {
    try {
      const response = await axios.get('http://127.0.0.1:4040/api/tunnels')
      const tunnel = response.data.tunnels.find((t: any) => t.proto === 'https')

      if (tunnel && !appUri) {
        appUri = tunnel.public_url
        console.log(`🔒 Ngrok Tunnel: ${appUri}\n`)
      }
    } catch {
      console.log('⏳ Aguardando ngrok iniciar...')
    }
  }, 2000)

  ngrok.stdout.on('data', (data: Buffer) => {
    const output = data.toString()
    if (output.includes('started tunnel') || output.includes('url=')) {
      console.log(`✅ Túnel ngrok conectado`)
    }
  })

  ngrok.stderr.on('data', (data: Buffer) => {
    const output = data.toString()
    if (output.includes('ERR')) {
      console.error('❌ Erro ngrok:', output)

      if (output.includes('ERR_NGROK_334') || output.includes('already online')) {
        console.log('\n💡 Solução: Execute "pkill ngrok" para encerrar processos antigos\n')
      }
    }
  })

  ngrok.on('error', (error: Error) => {
    console.error('❌ Erro no túnel:', error.message)
    console.log('💡 Instale o ngrok: brew install ngrok/ngrok/ngrok')
  })

  ngrok.on('close', (code: number) => {
    if (code !== 0) console.log(`⚠️ Túnel encerrado com código ${code}`)
  })

  process.on('SIGINT', () => {
    ngrok.kill()
    process.exit(0)
  })
}

new Elysia()
  .get('/', ({ set }) => {
    const loginUrl = 'https://accounts.spotify.com/authorize'
    const state = (Math.random() + 1).toString(36).substring(2)
    const clientId = process.env.CLIENT_ID
    const redirectUri = `${appUri}/callback`
    const queryUrl = `?response_type=code&client_id=${clientId}&scope=playlist-modify-public,user-library-read,user-library-modify&redirect_uri=${redirectUri}&state=${state}`

    set.redirect = `${loginUrl}${queryUrl}`
  })
  .get('/callback', async ({ set, query }) => {
    const code = query.code || null
    const state = query.state || null

    if (state === null) {
      return { error: true }
    }

    try {
      const { data } = await axios.post(
        'https://accounts.spotify.com/api/token',
        `code=${code}&redirect_uri=${appUri}/callback&grant_type=authorization_code`,
        { auth: { username: process.env.CLIENT_ID!, password: process.env.CLIENT_SECRET! } },
      )

      set.redirect = `${appUri}/app?token=${data.access_token}&refresh=${data.refresh_token}`
    } catch (err) {
      return { error: true, data: err }
    }
  })
  .get('/app', () => Bun.file(path.resolve('./app.html')))
  .get('/playlists', () => Bun.file(path.resolve('./playlists.json')))
  .ws('/ws/:jobId', {
    open(ws) {
      const jobId = ws.data.params.jobId
      console.log(`WebSocket opened for job: ${jobId}`)

      wsManager.registerConnection(jobId, ws)

      const job = jobStore.getJob(jobId)
      if (job) {
        ws.send(
          JSON.stringify({
            type: 'status',
            jobId,
            data: {
              status: job.status,
              progress: job.progress,
            },
          }),
        )
      } else {
        ws.send(
          JSON.stringify({
            type: 'error',
            jobId,
            data: { message: 'Job not found' },
          }),
        )
        ws.close()
      }
    },
    message(_ws, message) {
      console.log('Received message:', message)
    },
    close(ws) {
      const jobId = ws.data.params.jobId
      console.log(`WebSocket closed for job: ${jobId}`)
      wsManager.unregisterConnection(jobId, ws)
    },
  })
  .post('/process', async ({ body, query }) => {
    try {
      const { id, lastTotal } = body as { id: string; lastTotal: number }
      const { token } = query

      const { data } = await axios.get(`${apiUrl}/playlists/${id}/tracks?fields=total&limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      const { total } = data

      if (total === lastTotal) {
        return { result: 'same' }
      }

      const length = Math.ceil(total / 100)
      const allTracks: Track[] = []

      for (const page of Array.from({ length }, (_, k) => k + 1)) {
        const { data } = await axios.get<{ items: any[] }>(
          `${apiUrl}/playlists/${id}/tracks?limit=100&offset=${(page - 1) * 100}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )

        allTracks.push(
          ...data.items
            .filter(obj => obj.track)
            .map(obj => ({
              id: obj.track.id,
              albumName: obj.track.album.name,
              name: obj.track.name,
              date: obj.track.album.release_date,
            })),
        )
      }

      const tracks = allTracks.map((item, number) => ({ ...item, number }))
      const sortedTracks = lodash.orderBy(tracks, ['date', 'albumName', 'name'], ['desc', 'asc', 'asc'])
      const playlist = playlistDb.get(id)

      let count = 0
      let changed = 0

      if (playlist) {
        const changeCount = countChanged(sortedTracks)

        const bar = new cliProgress.SingleBar({
          etaBuffer: changeCount,
          format: `${playlist.name} [{bar}] {percentage}% | ETA: {eta_formatted} | {value}/{total} | {duration_formatted}`,
        })

        bar.start(changeCount, 0)

        for (const track of sortedTracks) {
          if (track.number !== count) {
            await delay(150)
            await tryReorder(token!, id, track.number, count)

            const isBefore = track.number > count

            sortedTracks.forEach(st => {
              if (isBefore) {
                if (st.number >= count && st.number < track.number) {
                  st.number += 1
                }
              } else if (st.number <= count && st.number > track.number) {
                st.number -= 1
              }
            })

            bar.increment()

            track.number = count
            changed++
          }

          count++
        }

        bar.stop()
        playlistDb.set(id, { ...playlist, lastTotal: total })
      }

      return { result: 'change', tracks: changed }
    } catch (err) {
      return { error: true, data: err }
    }
  })
  .post('/liked', async ({ query }) => {
    try {
      const { token, refresh } = query

      if (!token) {
        return { error: true, message: 'Token required' }
      }

      const job = jobStore.createJob('liked', {
        type: 'liked',
        token: token as string,
        refresh: refresh as string,
      })

      processLikedTracks(job.id).catch(err => {
        console.error(`Job ${job.id} crashed:`, err)
      })

      return {
        jobId: job.id,
        message: 'Job started',
        wsUrl: `/ws/${job.id}`,
      }
    } catch (err) {
      return { error: true, data: err }
    }
  })
  .get('/jobs/:jobId/status', ({ params }) => {
    const { jobId } = params
    const job = jobStore.getJob(jobId)

    if (!job) {
      return { error: true, message: 'Job not found' }
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      result: job.result,
      startTime: job.startTime,
      endTime: job.endTime,
      duration: job.endTime && job.startTime ? job.endTime - job.startTime : undefined,
    }
  })
  .listen({ port, idleTimeout: 255 }, () => {
    console.log(`\n🚀 Servidor rodando em http://localhost:${port}`)
    startTunnel()
  })

function countChanged(allTracks: Array<{ number: number }>) {
  let count = 0
  let changed = 0
  const tracks = allTracks.map(track => Object.assign({}, track))

  for (const track of tracks) {
    if (track.number !== count) {
      const isBefore = track.number > count

      tracks.forEach(st => {
        if (isBefore) {
          if (st.number >= count && st.number < track.number) {
            st.number += 1
          }
        } else if (st.number <= count && st.number > track.number) {
          st.number -= 1
        }
      })

      track.number = count
      changed++
    }

    count++
  }

  return changed
}
