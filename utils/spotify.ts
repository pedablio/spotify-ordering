import axios from 'axios'
import retry from 'retry'

const apiUrl = 'https://api.spotify.com/v1'

export async function trySave(token: string, trackId: string): Promise<void> {
  const operation = retry.operation({ retries: 5, factor: 2 })

  return new Promise<void>((resolve, reject) => {
    operation.attempt(async currentNumber => {
      try {
        await axios.put(`${apiUrl}/me/tracks`, { ids: [trackId] }, { headers: { Authorization: `Bearer ${token}` } })
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

export async function tryReorder(
  token: string,
  playlist: string,
  start: number,
  insertBefore: number,
): Promise<void> {
  const operation = retry.operation({ retries: 5, factor: 2 })

  return new Promise<void>((resolve, reject) => {
    operation.attempt(async currentNumber => {
      try {
        await axios.put(
          `${apiUrl}/playlists/${playlist}/tracks`,
          { range_start: start, insert_before: insertBefore },
          { headers: { Authorization: `Bearer ${token}` } },
        )
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
