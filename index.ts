import { Elysia } from 'elysia'
import path from 'path'
import axios from 'axios'
import SpotifyWebApi from 'spotify-web-api-node'
import JSONdb from 'simple-json-db'
import retry from 'retry'
import delay from 'delay'
import cliProgress from 'cli-progress'
import lodash from 'lodash'

interface Track {
  id: string
  albumName: string
  name: string
  date: string
}

interface SavedTrack {
  name: string
  lastTotal: number
}

const playlistDb = new JSONdb<SavedTrack>('./playlists.json', { jsonSpaces: 2 as unknown as boolean })

new Elysia()
  .get('/', ({ set }) => {
    const loginUrl = 'https://accounts.spotify.com/authorize'
    const state = (Math.random() + 1).toString(36).substring(2)
    const clientId = process.env.CLIENT_ID
    const redirectUri = `${process.env.APP_URI}/callback`
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
        `code=${code}&redirect_uri=${process.env.APP_URI}/callback&grant_type=authorization_code`,
        { auth: { username: process.env.CLIENT_ID!, password: process.env.CLIENT_SECRET! } },
      )

      set.redirect = `${process.env.APP_URI}/app?token=${data.access_token}&refresh=${data.refresh_token}`
    } catch (err) {
      return { error: true, data: err }
    }
  })
  .get('/app', () => Bun.file(path.resolve('./app.html')))
  .get('/playlists', () => Bun.file(path.resolve('./playlists.json')))
  .post('/process', async ({ body, query }) => {
    try {
      const { id, lastTotal } = body as { id: string; lastTotal: number }
      const { token } = query

      const api = new SpotifyWebApi({ accessToken: token as string })
      const resp = await api.getPlaylistTracks(id, { limit: 1, fields: 'total' })

      const { total } = resp.body

      if (total === lastTotal) {
        return { result: 'same' }
      }

      const length = Math.ceil(total / 100)
      const allTracks: Track[] = []

      for (const page of Array.from({ length }, (_, k) => k + 1)) {
        const { body } = await api.getPlaylistTracks(id, {
          limit: 100,
          offset: (page - 1) * 100,
        })

        allTracks.push(
          ...body.items
            .filter(obj => obj.track)
            .map(obj => ({
              id: obj.track!.id,
              albumName: obj.track!.album.name,
              name: obj.track!.name,
              date: obj.track!.album.release_date,
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
            await tryReorder(api, id, track.number, count)

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

      const api = new SpotifyWebApi({
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        redirectUri: process.env.APP_URI,
      })

      api.setAccessToken(token as string)
      api.setRefreshToken(refresh as string)

      const resp = await api.getMySavedTracks({ limit: 1 })

      const { total } = resp.body
      const length = Math.ceil(total / 50)
      const allTracks: Track[] = []

      for (const page of Array.from({ length }, (_, k) => k + 1)) {
        const { body } = await api.getMySavedTracks({ limit: 50, offset: (page - 1) * 50 })

        allTracks.push(
          ...body.items.map(obj => ({
            id: obj.track.id,
            name: obj.track.name,
            albumName: obj.track.album.name,
            date: obj.track.album.release_date,
          })),
        )
      }

      const tracks = allTracks.map((item, number) => ({ ...item, number }))
      const sortedTracks = lodash.orderBy(tracks, ['date', 'albumName', 'name'], ['desc', 'asc', 'asc'])
      const changedIndex = lodash.findLastIndex(sortedTracks, (track, index) => track.number !== index)

      if (changedIndex === -1) {
        return { result: 'same' }
      }

      const changedTracks = sortedTracks.slice(0, changedIndex + 1).reverse()
      const bar = new cliProgress.SingleBar({
        etaBuffer: changedTracks.length,
        format: `Curtidas [{bar}] {percentage}% | ETA: {eta_formatted} | {value}/{total} | {duration_formatted}`,
      })

      bar.start(changedTracks.length, 0)

      let trackNumber = 1

      for (const track of changedTracks) {
        if (trackNumber % 500 === 0) {
          const { body } = await api.refreshAccessToken()
          api.setAccessToken(body.access_token)
        }

        await trySave(api, track.id)
        await delay(2000)

        bar.increment()

        trackNumber++
      }

      bar.stop()

      return { result: 'change', tracks: changedTracks.length }
    } catch (err) {
      return { error: true, data: err }
    }
  })
  .listen(4354)

async function tryReorder(api: SpotifyWebApi, playlist: string, start: number, insertBefore: number) {
  let operation = retry.operation({ retries: 5, factor: 2 })

  return new Promise<void>((resolve, reject) => {
    operation.attempt(async currentNumber => {
      try {
        await api.reorderTracksInPlaylist(playlist, start, insertBefore)
        resolve()
      } catch (error) {
        console.log(`Trying in ${currentNumber}`, error)

        if (!operation.retry(error as Error)) {
          reject(operation.mainError())
          return
        }
      }
    })
  })
}

async function trySave(api: SpotifyWebApi, trackId: string) {
  const operation = retry.operation({ retries: 5, factor: 2 })

  return new Promise<void>((resolve, reject) => {
    operation.attempt(async currentNumber => {
      try {
        await api.addToMySavedTracks([trackId])
        resolve()
      } catch (error) {
        console.log(`Trying in ${currentNumber}`, error)

        if (!operation.retry(error as Error)) {
          reject(operation.mainError())
        }
      }
    })
  })
}

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
