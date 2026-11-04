// Chimes describe people, not their devices or a LiveKit reconnect snapshot.
export class CallPresence {
  private identities = new Set<string>();
  private self = '';
  private ready = false;
  private play: (kind: 'join' | 'leave') => unknown;
  constructor(play: (kind: 'join' | 'leave') => unknown) {
    this.play = play;
  }
  private user(identity: string) {
    return identity.split('.')[0];
  }
  start(identities: Iterable<string>, self: string) {
    this.self = this.user(self);
    this.identities = new Set(identities);
    this.ready = true;
  }
  pause() {
    this.ready = false;
  }
  joined(identity: string) {
    if (!this.ready || this.identities.has(identity)) return;
    const user = this.user(identity);
    const present = [...this.identities].some((id) => this.user(id) === user);
    this.identities.add(identity);
    if (user !== this.self && !present) this.play('join');
  }
  left(identity: string) {
    if (!this.ready || !this.identities.delete(identity)) return;
    const user = this.user(identity);
    if (user !== this.self && ![...this.identities].some((id) => this.user(id) === user)) this.play('leave');
  }
}
