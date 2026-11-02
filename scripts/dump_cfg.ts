import mc from 'minecraft-protocol'
const client = mc.createClient({ host: '127.0.0.1', port: 25565, username: 'Agent_A', version: '26.3', auth: 'offline' })
client.on('state', (s: string) => {
  console.log(`[state] -> ${s}`)
  if (s === mc.states.CONFIGURATION) {
    client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from('fabric:registry/sync\0fabric:registry/sync/complete\0') })
    client.write('custom_payload', { channel: 'minecraft:brand', data: Buffer.concat([Buffer.from([6]), Buffer.from('fabric')]) })
  }
})
client.on('ping', (p: any) => client.write('pong', { id: p.id }))
client.on('custom_payload', (p: any) => {
  const d = Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data?.data ?? [])
  console.log(`[${client.state}] custom_payload ${p.channel} (${d.length}B)`)
  if (p.channel === 'fabric:registry/sync') {
    console.log('  -> replying fabric:registry/sync/complete')
    client.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
  }
})
client.on('packet', (data: any, meta: any) => {
  if (['custom_payload','ping','keep_alive','map_chunk'].includes(meta.name)) return
  if (client.state === 'configuration' || client.state === 'play')
    console.log(`[${client.state}] ${meta.name} ${JSON.stringify(data).slice(0, 120)}`)
})
client.on('disconnect', (p: any) => { console.log('DISCONNECT:', JSON.stringify(p).slice(0, 500)); process.exit(0) })
client.on('end', (r: any) => { console.log('END:', String(r)); process.exit(0) })
client.on('error', (e: any) => { console.log('ERR:', e?.message); process.exit(1) })
setTimeout(() => { console.log('--- 15s done ---'); process.exit(0) }, 15000)
