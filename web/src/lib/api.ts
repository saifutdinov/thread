// Thin typed client for /api. Binary fields travel as standard base64.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'network');
  return data as T;
}

export interface User {
  id: number;
  name: string;
  hide_online: boolean;
  created_at: number;
  avatar_v?: number;
}

export interface Me {
  user: User;
  device: { id: number; status: 'pending' | 'active'; recovery: boolean };
}

export interface Member {
  id: number;
  name: string;
  last_read: number;
  online: boolean;
  last_seen: number;
  avatar_v?: number;
  avatar_epoch?: number;
  invitee?: boolean; // I invited them, so I can make them a recovery link
  since?: number; // their first key epoch here (0 or none: from the start)
}

// Picture is a sealed avatar or group photo (see profiles.go).
export interface Picture {
  epoch: number;
  v: number;
  body: string;
}

export interface LinkPreview {
  site?: string;
  title?: string;
  desc?: string;
  image?: string; // base64
}

export interface RawReaction {
  user: number;
  epoch: number;
  body: string;
}

export interface RawMessage {
  id: number;
  chat: number;
  user: number;
  device: number;
  cid: string;
  epoch: number;
  body?: string;
  sig?: string;
  reply_to?: number;
  media?: boolean;
  seq: number;
  at: number;
  edited?: number;
  deleted?: boolean;
  reactions?: RawReaction[];
}

export interface RawChat {
  id: number;
  kind: 'direct' | 'group';
  title?: string;
  title_epoch: number;
  epoch: number;
  rotate: boolean;
  cleared_upto: number;
  created_by: number;
  created_at: number;
  unread: number;
  members: Member[];
  last?: RawMessage;
  needs_key?: number[];
  pinned?: number;
  pinned_msg?: RawMessage;
  photo_v?: number;
}

export interface WrappedKey {
  chat: number;
  epoch: number;
  device: number;
  wrapped: string;
}

export interface DevicePub {
  id: number;
  user: number;
  enc_pub: string;
  sig_pub?: string;
}

export interface Device {
  id: number;
  label: string;
  status: 'pending' | 'active';
  created_at: number;
  last_seen: number;
  online: boolean;
  current: boolean;
}

export interface PendingDevice {
  id: number;
  user: number;
  name: string;
  label: string;
  enc_pub: string;
  sig_pub: string;
  created_at: number;
  own: boolean;
}

export interface InviteInfo {
  kind: 'register' | 'direct' | 'group';
  chat_id?: number;
  title?: string;
  title_epoch?: number;
  members?: number;
  inviter?: string;
  bundle?: string;
  member?: boolean;
}

export interface NewDevice {
  enc_pub: string;
  sig_pub: string;
  label: string;
}

export interface NewInvite {
  id: string;
  bundle: string;
  max_uses: number;
}

export interface Sealed {
  epoch: number;
  body: string;
  sig: string;
}

export const api = {
  me: () => call<Me>('GET', '/me'),
  updateMe: (p: { name?: string; hide_online?: boolean }) => call('PATCH', '/me', p),
  challenge: () => call<{ nonce: string }>('POST', '/auth/challenge', {}),
  login: (p: { password: string; device_id?: number; nonce?: string; sig?: string; device?: NewDevice }) =>
    call<{ device_id: number; status: 'pending' | 'active' }>('POST', '/auth/login', p),
  logout: () => call('POST', '/auth/logout', {}),
  changePassword: (password: string) => call<{ password: string }>('POST', '/auth/password', { password }),

  peek: (key: string) => call<InviteInfo>('POST', '/invites/peek', { key }),
  redeem: (p: { key: string; name?: string; device?: NewDevice }) =>
    call<{ chat_id: number; bundle?: string; password?: string; device_id?: number }>('POST', '/invites/redeem', p),
  invites: (chat: number) =>
    call<{ id: string; max_uses: number; uses: number; expires_at: number }[]>('GET', `/chats/${chat}/invites`),
  createInvite: (chat: number, inv: NewInvite) => call('POST', `/chats/${chat}/invites`, inv),
  deleteInvite: (id: string) => call('DELETE', `/invites/${id}`),
  createRecovery: (p: { user: number; id: string; bundle: string }) => call('POST', '/recoveries', p),
  peekRecovery: (key: string) => call<{ name: string; by: string; bundle: string }>('POST', '/recoveries/peek', { key }),
  redeemRecovery: (p: { key: string; device: NewDevice; keys: Omit<WrappedKey, 'device'>[] }) =>
    call<{ password: string; device_id: number; chats: number[] }>('POST', '/recoveries/redeem', p),

  chats: () => call<RawChat[]>('GET', '/chats'),
  createChat: (p: { kind: 'direct' | 'group'; title?: string; keys: WrappedKey[]; invite: NewInvite }) =>
    call<{ chat_id: number }>('POST', '/chats', p),
  leaveChat: (chat: number) => call('DELETE', `/chats/${chat}`),
  messages: (chat: number, before = 0, media = false) =>
    call<RawMessage[]>('GET', `/chats/${chat}/messages?before=${before}&limit=50${media ? '&media=1' : ''}`),
  send: (chat: number, p: Sealed & { cid: string; reply_to?: number; media?: string[] }) =>
    call<RawMessage>('POST', `/chats/${chat}/messages`, p),
  clearHistory: (chat: number) => call('DELETE', `/chats/${chat}/messages`),
  read: (chat: number, id: number) => call('POST', `/chats/${chat}/read`, { id }),
  rotate: (chat: number, epoch: number, keys: WrappedKey[]) => call('POST', `/chats/${chat}/rotate`, { epoch, keys }),
  pin: (chat: number, id: number) => call('PUT', `/chats/${chat}/pin`, { id }),
  setAvatar: (body: { copy?: boolean; v?: number; items: { chat: number; epoch: number; body: string | null }[] }) =>
    call<{ v: number }>('PUT', '/me/avatar', body),
  avatar: (chat: number, user: number) => call<Picture>('GET', `/chats/${chat}/avatars/${user}`),
  photo: (chat: number) => call<Picture>('GET', `/chats/${chat}/photo`),
  setPhoto: (chat: number, epoch: number, body: string | null) => call('PUT', `/chats/${chat}/photo`, { epoch, body }),
  preview: (url: string) => call<LinkPreview>('POST', '/preview', { url }),
  copyMedia: (id: string, chat: number) => call<{ id: string }>('POST', `/media/${id}/copy`, { chat }),
  chatDevices: (chat: number) => call<DevicePub[]>('GET', `/chats/${chat}/devices`),
  edit: (id: number, p: Sealed) => call<RawMessage>('PATCH', `/messages/${id}`, p),
  deleteMessage: (id: number) => call<RawMessage>('DELETE', `/messages/${id}`),
  react: (id: number, p: { epoch: number; body: string }) => call<RawMessage>('PUT', `/messages/${id}/reaction`, p),
  unreact: (id: number) => call<RawMessage>('DELETE', `/messages/${id}/reaction`),
  sync: (since: number) => call<{ messages: RawMessage[]; seq: number; full: boolean }>('GET', `/sync?since=${since}`),

  keys: () => call<WrappedKey[]>('GET', '/keys'),
  shareKeys: (keys: WrappedKey[]) => call('POST', '/keys', { keys }),
  devices: () => call<Device[]>('GET', '/devices'),
  devicePubs: (ids: number[]) => call<DevicePub[]>('GET', `/devices/pub?ids=${ids.join(',')}`),
  pending: () => call<PendingDevice[]>('GET', '/pending'),
  recovery: () => call('POST', '/devices/recovery', {}),
  approve: (id: number, keys: WrappedKey[]) => call('POST', `/devices/${id}/approve`, { keys }),
  revoke: (id: number) => call('POST', `/devices/${id}/revoke`, {}),

  turn: () => call<{ ice_servers: RTCIceServer[] }>('GET', '/turn'),
  pushKey: () => call<{ key: string }>('GET', '/push/key'),
  subscribe: (sub: PushSubscriptionJSON) => call('POST', '/push', sub),
  unsubscribe: () => call('DELETE', '/push'),

  async upload(chat: number, blob: Bytes): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`/api/media?chat=${chat}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
    } catch {
      throw new ApiError(0, 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || 'network');
    return data.id;
  },

  async download(id: string): Promise<Bytes> {
    const res = await fetch(`/api/media/${id}`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'download');
    return new Uint8Array(await res.arrayBuffer());
  },
};

type Bytes = Uint8Array<ArrayBuffer>;
