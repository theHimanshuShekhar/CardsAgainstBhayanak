import { writeSync } from 'node:fs'

// Fault only the owned child process's OS output boundary. The parent pauses
// stderr consumption before signalling, and observes readiness on stdout.
process.on('SIGUSR2', () => {
  let written = 0
  for (const buffer of [Buffer.alloc(65536, 'x'), Buffer.from('x')]) {
    for (;;) {
      try {
        written += writeSync(2, buffer)
      } catch (error) {
        if (error.code !== 'EAGAIN') throw error
        break
      }
    }
  }
  writeSync(1, `\nCAB_STDERR_SATURATED:${written}\n`)
})
