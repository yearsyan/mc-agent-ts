import mc from 'minecraft-protocol'
const client = mc.createClient({ host: '127.0.0.1', port: 25565, username: 'Agent_A', version: '26.3', auth: 'offline' })
client.on('state', (s: string) => {
  if (s === mc.states.CONFIGURATION) {
    client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from('fabric:registry/sync\0fabric:registry/sync/complete\0') })
    client.write('custom_payload', { channel: 'minecraft:brand', data: Buffer.concat([Buffer.from([6]), Buffer.from('fabric')]) })
  }
})
client.on('ping', (p: any) => client.write('pong', { id: p.id }))
client.on('custom_payload', (p: any) => {
  if (p.channel === 'fabric:registry/sync') {
    client.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
  }
})
client.on('select_known_packs', (p: any) => console.log('>>> select_known_packs EVENT:', JSON.stringify(p).slice(0, 200)))
client.on('end', (r: any) => { console.log('END:', String(r).slice(0,200)); process.exit(0) })
client.on('error', (e: any) => { console.log('ERR:', e?.message); })
setTimeout(() => process.exit(0), 8000)
