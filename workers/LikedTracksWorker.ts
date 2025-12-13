import axios from 'axios'
import delay from 'delay'
import lodash from 'lodash'
import cliProgress from 'cli-progress'
import { jobStore } from '../services/JobStore'
import { wsManager } from '../services/WebSocketManager'
import type { Track } from '../types/track'
import { trySave } from '../utils/spotify'

const apiUrl = 'https://api.spotify.com/v1'

export async function processLikedTracks(jobId: string): Promise<void> {
  console.log(`\n=== Starting Liked Tracks Job ${jobId} ===`)

  const job = jobStore.getJob(jobId)
  if (!job) {
    console.error(`Job ${jobId} not found`)
    return
  }

  jobStore.updateStatus(jobId, 'running')
  wsManager.broadcast(jobId, {
    type: 'status',
    jobId,
    data: { status: 'running' },
  })

  try {
    let { token, refresh } = job.config

    // PHASE 1: Fetch all liked tracks
    console.log('Phase 1: Fetching liked tracks...')
    jobStore.updateProgress(jobId, {
      current: 0,
      total: 1,
      percentage: 0,
      message: 'Buscando músicas curtidas...',
    })
    wsManager.broadcast(jobId, {
      type: 'progress',
      jobId,
      data: jobStore.getJob(jobId)!.progress,
    })

    const { data } = await axios.get(`${apiUrl}/me/tracks?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const { total } = data
    const length = Math.ceil(total / 50)
    const allTracks: Track[] = []

    for (const page of Array.from({ length }, (_, k) => k + 1)) {
      const { data } = await axios.get<{ items: any[] }>(
        `${apiUrl}/me/tracks?limit=50&offset=${(page - 1) * 50}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )

      allTracks.push(
        ...data.items.map(obj => ({
          id: obj.track.id,
          name: obj.track.name,
          albumName: obj.track.album.name,
          date: obj.track.album.release_date,
        })),
      )

      const progress = Math.floor((page / length) * 20)
      jobStore.updateProgress(jobId, {
        current: page,
        total: length,
        percentage: progress,
        message: `Carregando músicas... ${page}/${length}`,
      })
      wsManager.broadcast(jobId, {
        type: 'progress',
        jobId,
        data: jobStore.getJob(jobId)!.progress,
      })
    }

    console.log(`Fetched ${allTracks.length} tracks`)

    // PHASE 2: Sort and check if changes needed
    console.log('Phase 2: Analyzing changes...')

    const tracks = allTracks.map((item, number) => ({ ...item, number }))
    const sortedTracks = lodash.orderBy(tracks, ['date', 'albumName', 'name'], ['desc', 'asc', 'asc'])
    const changedIndex = lodash.findLastIndex(sortedTracks, (track, index) => track.number !== index)

    if (changedIndex === -1) {
      console.log('No changes needed')
      jobStore.updateStatus(jobId, 'completed')
      jobStore.setResult(jobId, {
        success: true,
        tracksChanged: 0,
        message: 'Nada foi alterado',
      })
      wsManager.broadcast(jobId, {
        type: 'complete',
        jobId,
        data: jobStore.getJob(jobId)!.result!,
      })
      return
    }

    // PHASE 3: Re-save tracks in correct order
    console.log(`Phase 3: Reordering ${changedIndex + 1} tracks...`)
    const changedTracks = sortedTracks.slice(0, changedIndex + 1).reverse()

    const bar = new cliProgress.SingleBar({
      etaBuffer: changedTracks.length,
      format: `Curtidas [{bar}] {percentage}% | ETA: {eta_formatted} | {value}/{total} | {duration_formatted}`,
    })

    bar.start(changedTracks.length, 0)

    let trackNumber = 1

    for (const track of changedTracks) {
      if (trackNumber % 500 === 0) {
        console.log('Refreshing token...')
        const { data } = await axios.post(
          'https://accounts.spotify.com/api/token',
          `grant_type=refresh_token&refresh_token=${refresh}`,
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            auth: {
              username: process.env.CLIENT_ID!,
              password: process.env.CLIENT_SECRET!,
            },
          },
        )
        token = data.access_token
        refresh = data.refresh_token || refresh
      }

      await trySave(token!, track.id)
      await delay(2000)

      bar.increment()

      const percentage = 20 + Math.floor((trackNumber / changedTracks.length) * 80)
      jobStore.updateProgress(jobId, {
        current: trackNumber,
        total: changedTracks.length,
        percentage,
        message: `Recurtindo músicas... ${trackNumber}/${changedTracks.length}`,
      })

      if (trackNumber % 10 === 0 || trackNumber === changedTracks.length) {
        wsManager.broadcast(jobId, {
          type: 'progress',
          jobId,
          data: jobStore.getJob(jobId)!.progress,
        })
      }

      trackNumber++
    }

    bar.stop()

    // PHASE 4: Complete
    console.log(`\n=== Job ${jobId} Completed: ${changedTracks.length} tracks ===`)

    jobStore.updateStatus(jobId, 'completed')
    jobStore.setResult(jobId, {
      success: true,
      tracksChanged: changedTracks.length,
      message: `${changedTracks.length} músicas recurtidas`,
    })
    wsManager.broadcast(jobId, {
      type: 'complete',
      jobId,
      data: jobStore.getJob(jobId)!.result!,
    })
  } catch (err) {
    console.error(`Job ${jobId} failed:`, err)
    jobStore.updateStatus(jobId, 'failed')
    jobStore.setResult(jobId, {
      success: false,
      message: 'Erro ao processar',
      error: err,
    })
    wsManager.broadcast(jobId, {
      type: 'error',
      jobId,
      data: jobStore.getJob(jobId)!.result!,
    })
  }
}
