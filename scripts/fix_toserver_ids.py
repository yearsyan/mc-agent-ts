#!/usr/bin/env python3
"""用 26.3 服务端 jar 的真实注册顺序修正 minecraft-data 26.3 协议表的 play.toServer 包 ID。
用法: fix_toserver_ids.py <协议json路径> <真表文件(server_full.txt)>
"""
import json, re, sys

proto_path, list_path = sys.argv[1], sys.argv[2]

# 服务器注册名 -> nmp 协议表名
NORM = {
  'ACCEPT_TELEPORTATION': 'teleport_confirm', 'ATTACK': 'attack', 'BLOCK_ENTITY_TAG_QUERY': 'query_block_nbt',
  'BUNDLE_ITEM_SELECTED': 'select_bundle_item', 'CHANGE_DIFFICULTY': 'set_difficulty', 'CHANGE_GAME_MODE': 'change_gamemode',
  'CHAT_ACK': 'message_acknowledgement', 'CHAT_COMMAND': 'chat_command', 'CHAT_COMMAND_SIGNED': 'chat_command_signed',
  'CHAT': 'chat_message', 'CHAT_SESSION_UPDATE': 'chat_session_update', 'CHUNK_BATCH_RECEIVED': 'chunk_batch_received',
  'CLIENT_COMMAND': 'client_command', 'CLIENT_TICK_END': 'tick_end', 'CLIENT_INFORMATION': 'settings',
  'COMMAND_SUGGESTION': 'tab_complete', 'CONFIGURATION_ACKNOWLEDGED': 'configuration_acknowledged',
  'CONTAINER_BUTTON_CLICK': 'enchant_item', 'CONTAINER_CLICK': 'window_click', 'CONTAINER_CLOSE': 'close_window',
  'CONTAINER_SLOT_STATE_CHANGED': 'set_slot_state', 'CUSTOM_PAYLOAD': 'custom_payload',
  'DEBUG_SUBSCRIPTION_REQUEST': 'debug_subscription_request', 'EDIT_BOOK': 'edit_book', 'ENTITY_TAG_QUERY': 'query_entity_nbt',
  'INTERACT': 'use_entity', 'JIGSAW_GENERATE': 'generate_structure', 'KEEP_ALIVE': 'keep_alive',
  'LOCK_DIFFICULTY': 'lock_difficulty', 'MOVE_PLAYER_POS': 'position', 'MOVE_PLAYER_POS_ROT': 'position_look',
  'MOVE_PLAYER_ROT': 'look', 'MOVE_PLAYER_STATUS_ONLY': 'flying', 'MOVE_VEHICLE': 'vehicle_move',
  'PADDLE_BOAT': 'steer_boat', 'PICK_ITEM_FROM_BLOCK': 'pick_item_from_block', 'PICK_ITEM_FROM_ENTITY': 'pick_item_from_entity',
  'PLACE_RECIPE': 'craft_recipe_request', 'PLAYER_ABILITIES': 'abilities', 'PLAYER_ACTION': 'block_dig',
  'PLAYER_COMMAND': 'entity_action', 'PLAYER_INPUT': 'player_input', 'PLAYER_LOADED': 'player_loaded',
  'PONG': 'pong', 'PUNCH': 'arm_animation', 'RECIPE_BOOK_CHANGE_SETTINGS': 'recipe_book', 'RECIPE_BOOK_SEEN_RECIPE': 'displayed_recipe',
  'RENAME_ITEM': 'name_item', 'RESOURCE_PACK': 'resource_pack_receive', 'SEEN_ADVANCEMENTS': 'advancement_tab',
  'SELECT_TRADE': 'select_trade', 'SET_BEACON': 'set_beacon_effect', 'SET_CARRIED_ITEM': 'held_item_slot',
  'SET_COMMAND_BLOCK': 'update_command_block', 'SET_COMMAND_MINECART': 'update_command_block_minecart',
  'SET_CREATIVE_MODE_SLOT': 'set_creative_slot', 'SET_GAME_RULE': 'set_game_rule', 'SET_JIGSAW_BLOCK': 'update_jigsaw_block',
  'SET_STRUCTURE_BLOCK': 'update_structure_block', 'SET_TEST_BLOCK': 'set_test_block', 'SIGN_UPDATE': 'update_sign',
  'SPECTATOR_ACTION': 'spectator_action', 'TELEPORT_TO_ENTITY': 'spectate', 'TEST_INSTANCE_BLOCK_ACTION': 'test_instance_block_action',
  'USE_ITEM_ON': 'block_place', 'USE_ITEM': 'use_item', 'CUSTOM_CLICK_ACTION': 'custom_click_action',
}

order = []
for line in open(list_path):
    m = re.search(r'SERVERBOUND_([A-Z_0-9]+)', line)
    if m:
        name = NORM.get(m.group(1))
        if name is None:
            print(f'注: {m.group(1)} 不在 NORM, 记为占位')
            name = f'__missing_{m.group(1).lower()}'
        order.append(name)

proto = json.load(open(proto_path))
types = proto['play']['toServer']['types']
switch = types['packet'][1]
mapper = None
fields = None
for item in switch:
    if item.get('name') == 'name':
        mapper = item['type'][1]
    if item.get('name') == 'params':
        fields = item['type'][1]['fields']
assert mapper and fields, 'mapper/fields 未找到'

old_mappings = mapper['mappings']
new_mappings = {}
missing = []
id_of = {}
for i, name in enumerate(order):
    key = f'0x{i:02x}'
    if name not in fields:
        missing.append((key, name))
        continue
    new_mappings[key] = name
    id_of[name] = key

if missing:
    print('跳过 (无字段定义):', missing)
removed = [v for v in old_mappings.values() if v not in order]
mapper['mappings'] = new_mappings
json.dump(proto, open(proto_path, 'w'), indent=2)
print(f'重排 {len(order)} 个 toServer id; 移除: {removed}; block_dig 现在 id=' +
      f"0x{[k for k,v in new_mappings.items() if v=='block_dig'][0]}")
