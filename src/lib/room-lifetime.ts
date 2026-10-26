import { redis, KEYS, ROOM_TTL_SECONDS } from './redis'

// All durable room state shares the root's idle deadline. New/internal writes
// inherit it; only accepted participant mutations renew it. Enumerate keys
// rather than scanning a prefix: leases, grace and command locks have their
// own deadlines and must never be prolonged by somebody else's activity.
export const ROOM_LIFETIME_LUA = `
local function expireRoomKey(key)
  local root = string.match(key, '^game:[^:]+')
  local ttl = redis.call('PTTL', root)
  if ttl >= 0 then
    redis.call('PEXPIRE', key, ttl)
  elseif key ~= root then
    redis.call('DEL', key)
  end
end

local function renewRoomState(root)
  if not redis.call('HGET', root, 'status') then return 0 end
  redis.call('EXPIRE', root, ${ROOM_TTL_SECONDS})
  for _, suffix in ipairs({
    ':players', ':czarOrder', ':round', ':deck:black', ':deck:white',
    ':discard:black', ':discard:white', ':drops', ':round:submissions',
    ':round:order', ':round:resolving', ':round:revealed', ':round:votetally',
    ':round:tiebreak', ':round:voters', ':round:voterchoices', ':round:skipped'
  }) do
    expireRoomKey(root .. suffix)
  end
  for _, playerId in ipairs(redis.call('HKEYS', root .. ':players')) do
    expireRoomKey(root .. ':hand:' .. playerId)
  end
  return 1
end
`

export const EXPIRE_ROOM_KEY_LUA = `${ROOM_LIFETIME_LUA} expireRoomKey(KEYS[1])`

export async function expireRoomStateKeys(code: string, keys: string[]): Promise<void> {
  await redis.eval(
    `${ROOM_LIFETIME_LUA}
    for i = 2, #KEYS do expireRoomKey(KEYS[i]) end`,
    1 + keys.length,
    KEYS.game(code),
    ...keys,
  )
}
