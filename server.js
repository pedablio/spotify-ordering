import express from 'express'
import compression from 'compression'
import cors from 'cors'
import path from 'path'
import axios from 'axios'
import SpotifyWebApi from 'spotify-web-api-node'
import { Low, JSONFile } from 'lowdb'
import lodash from 'lodash'
import 'dotenv/config'

const app = express()

app.use(express.json())
app.use(compression())
app.use(cors())

const router = express.Router()
const playlistDb = new Low(new JSONFile('playlists.json'))

router.get('/', (req, res) => {
  const loginUrl = 'https://accounts.spotify.com/authorize'
  const state = (Math.random() + 1).toString(36).substring(2)
  const clientId = process.env.CLIENT_ID
  const redirectUri = `${process.env.APP_URI}/callback`
  const queryUrl = `?response_type=code&client_id=${clientId}&scope=playlist-modify-public,user-library-read,user-library-modify&redirect_uri=${redirectUri}&state=${state}`

  res.redirect(`${loginUrl}${queryUrl}`)
})

router.get('/app', (req, res) => res.sendFile(path.resolve('./app.html')))
router.get('/playlists', (req, res) => res.sendFile(path.resolve('./playlists.json')))
router.post('/process', async (req, res) => {
  try {
    const { id, lastTotal } = req.body
    const { token } = req.query

    const api = new SpotifyWebApi({ accessToken: token })
    const resp = await api.getPlaylistTracks(id, { limit: 1, fields: 'total' })

    const { total } = resp.body

    if (total === lastTotal) return res.json({ result: 'same' })

    await playlistDb.read()

    const length = Math.ceil(total / 100)
    const allTracks = []

    for (const page of Array.from({ length }, (_, k) => k + 1)) {
      const { body } = await api.getPlaylistTracks(id, {
        limit: 100,
        offset: (page - 1) * 100,
      })

      allTracks.push(
        ...body.items.map(obj => ({
          id: obj.track.id,
          name: obj.track.name,
          date: obj.track.album.release_date,
        })),
      )
    }

    const tracks = allTracks.map((item, number) => ({ ...item, number }))
    const sortedTracks = lodash.orderBy(tracks, ['date', 'name'], ['desc', 'asc'])

    let count = 0
    let changed = 0

    for (const track of sortedTracks) {
      if (track.number !== count) {
        await retryWithBackOff(
          {
            retries: 5,
            minDelay: 1000,
            maxDelay: 5000,
            factor: 2,
          },
          api.reorderTracksInPlaylist(id, track.number, count),
        )

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

        track.number = count
        changed++
      }

      count++
    }

    const playlist = playlistDb.data.find(item => item.id === id)
    playlist.lastTotal = total

    await playlistDb.write()

    return res.json({ result: 'change', tracks: changed })
  } catch (err) {
    return res.json({ error: true, data: err })
  }
})

router.post('/liked', async (req, res) => {
  try {
    const { token } = req.query

    const api = new SpotifyWebApi({ accessToken: token })

    const resp = await api.getMySavedTracks({ limit: 1 })

    const { total } = resp.body
    const length = Math.ceil(total / 50)
    const allTracks = []

    for (const page of Array.from({ length }, (_, k) => k + 1)) {
      const { body } = await api.getMySavedTracks({ limit: 50, offset: (page - 1) * 50 })

      allTracks.push(
        ...body.items.map(obj => ({
          id: obj.track.id,
          name: obj.track.name,
          date: obj.track.album.release_date,
        })),
      )
    }

    const tracks = allTracks.map((item, number) => ({ ...item, number }))
    const sortedTracks = lodash.orderBy(tracks, ['date', 'name'], ['desc', 'asc'])
    const changedIndex = lodash.findLastIndex(sortedTracks, (track, index) => track.number !== index)

    if (changedIndex === -1) {
      return res.json({ result: 'same' })
    }

    const changedTracks = sortedTracks.slice(0, changedIndex + 1).reverse()

    for (const track of changedTracks) {
      await api.addToMySavedTracks([track.id])
      await delay(2000)
    }

    return res.json({ result: 'change', tracks: changedTracks.length })
  } catch (err) {
    console.log(err)
    return res.json({ error: true, data: err })
  }
})

router.get('/callback', async (req, res) => {
  const code = req.query.code || null
  const state = req.query.state || null

  if (state === null) {
    return res.json({ error: true })
  }
  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      `code=${code}&redirect_uri=${process.env.APP_URI}/callback&grant_type=authorization_code`,
      { auth: { username: process.env.CLIENT_ID, password: process.env.CLIENT_SECRET } },
    )

    return res.redirect(`${process.env.APP_URI}/app?token=${data.access_token}`)
  } catch (err) {
    return res.json({ error: true, data: err })
  }
})

app.use(router)
app.listen(4354)

const delay = time => new Promise(resolve => setTimeout(resolve, time))
const calculateBackoff = ({ minDelay, maxDelay, factor }, attempt) => {
  const attemptBackoff = minDelay * factor ** attempt
  const backoff = Math.min(attemptBackoff, maxDelay)
  return backoff
}

const shouldHalt = (retries, attempt) => attempt >= retries
const invokeAction = (config, action, args, attempt) =>
  action(...args).catch(err =>
    shouldHalt(config.retries, attempt)
      ? Promise.reject(err)
      : delay(calculateBackoff(config, attempt)).then(() => invokeAction(config, action, args, attempt + 1)),
  )

const retryWithBackOff =
  (config, action) =>
  (...args) =>
    invokeAction(config, action, args, 0)
