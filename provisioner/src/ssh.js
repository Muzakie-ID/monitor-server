import net from 'node:net';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { config } from './config.js';
import { secrets } from './secrets.js';

const { Client } = ssh2;

export const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

export const fingerprintOf = (keyBuf) =>
  `SHA256:${createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '')}`;

/** Cek port SSH bisa dijangkau dari server pemantau (TCP saja, belum login). */
export function checkTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok, reason) => { sock.destroy(); resolve({ ok, reason }); };
    sock.setTimeout(timeoutMs, () => done(false, 'timeout'));
    sock.once('connect', () => done(true));
    sock.once('error', (err) => done(false, err.code ?? err.message));
  });
}

export class SshError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * Koneksi SSH ke server target.
 * creds: { authMethod: 'password' | 'key', password?, sudoPassword? }
 * Kata sandi hanya disimpan di objek ini (memori) dan tidak pernah ditulis ke log/DB.
 */
export class Remote {
  constructor({ host, port = 22, user }, creds) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.creds = creds;
    this.conn = null;
    this.fingerprint = null;
    this.sudoMode = null; // 'root' | 'nopasswd' | 'password'
  }

  /**
   * expectedFingerprint: kalau diisi, koneksi ditolak bila host key berbeda.
   * Tanpa itu, fingerprint dicatat dan koneksi diteruskan (pemanggil wajib minta konfirmasi
   * admin sebelum menjalankan perintah apa pun).
   */
  async connect({ expectedFingerprint } = {}) {
    const conn = new Client();
    const opts = {
      host: this.host,
      port: this.port,
      username: this.user,
      readyTimeout: config.sshReadyTimeoutMs,
      keepaliveInterval: 15_000,
      hostVerifier: (key) => {
        this.fingerprint = fingerprintOf(key);
        return !expectedFingerprint || expectedFingerprint === this.fingerprint;
      }
    };
    if (this.creds.authMethod === 'key') opts.privateKey = await secrets.sshPrivateKey();
    else {
      opts.password = this.creds.password;
      opts.tryKeyboard = true; // sebagian server hanya menawarkan keyboard-interactive
    }

    await new Promise((resolve, reject) => {
      conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) =>
        finish(prompts.map(() => this.creds.password ?? '')));
      conn.once('ready', resolve);
      conn.once('error', (err) => {
        if (expectedFingerprint && this.fingerprint && this.fingerprint !== expectedFingerprint) {
          reject(new SshError(
            `Host key server BERUBAH (sekarang ${this.fingerprint}). Koneksi dihentikan demi keamanan.`, 'HOSTKEY_CHANGED'));
        } else if (err.level === 'client-authentication') {
          reject(new SshError('Login SSH ditolak: username, kata sandi, atau kunci SSH salah.', 'AUTH'));
        } else if (err.level === 'client-timeout') {
          reject(new SshError('Koneksi SSH timeout.', 'TIMEOUT'));
        } else {
          reject(new SshError(`Koneksi SSH gagal: ${err.message}`, 'CONNECT'));
        }
      });
      conn.connect(opts);
    });
    this.conn = conn;
    return this.fingerprint;
  }

  /**
   * Ambil fingerprint host key TANPA login: koneksi diputus sebelum kata sandi/kunci
   * dikirim, jadi aman dipakai sebelum admin mengonfirmasi identitas server.
   */
  static fetchHostKey(host, port) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let fp = null;
      conn.once('error', () => {
        conn.end();
        fp ? resolve(fp) : reject(new SshError('Tidak bisa membaca host key server (apakah port ini benar-benar SSH?).', 'CONNECT'));
      });
      conn.once('ready', () => { conn.end(); resolve(fp); });
      conn.connect({
        host, port, username: 'pantau-hostkey-probe', readyTimeout: config.sshReadyTimeoutMs,
        hostVerifier: (key) => { fp = fingerprintOf(key); return false; }
      });
    });
  }

  close() {
    this.conn?.end();
    this.conn = null;
  }

  /** Jalankan perintah apa adanya. Mengembalikan { code, stdout, stderr }. */
  exec(command, { stdin, timeoutMs = config.commandTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new SshError('Belum terhubung', 'CONNECT'));
      this.conn.exec(command, (err, stream) => {
        if (err) return reject(new SshError(`Gagal menjalankan perintah: ${err.message}`, 'EXEC'));
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stream.close();
          reject(new SshError(`Perintah melebihi batas waktu ${Math.round(timeoutMs / 1000)} detik`, 'TIMEOUT'));
        }, timeoutMs);
        stream.on('data', (d) => { stdout += d; });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        });
        if (stdin !== undefined) stream.end(stdin);
        else stream.end();
      });
    });
  }

  /** Tentukan cara menjadi root: user root, sudo tanpa sandi, atau sudo dengan sandi. */
  async detectSudo() {
    const who = await this.exec('id -u');
    if (who.stdout.trim() === '0') return (this.sudoMode = 'root');
    const nopw = await this.exec('sudo -n true');
    if (nopw.code === 0) return (this.sudoMode = 'nopasswd');
    const pw = this.creds.sudoPassword || this.creds.password;
    if (!pw) {
      throw new SshError('User ini butuh kata sandi sudo. Isi kolom "Kata sandi sudo".', 'SUDO');
    }
    // -k: abaikan cache sudo supaya kata sandi benar-benar diuji
    const withPw = await this.exec("sudo -k -S -p '' true", { stdin: `${pw}\n` });
    if (withPw.code !== 0) {
      throw new SshError('Kata sandi sudo salah, atau user ini tidak punya hak sudo.', 'SUDO');
    }
    return (this.sudoMode = 'password');
  }

  /** Jalankan perintah shell sebagai root. */
  root(script, opts = {}) {
    const cmd = `LC_ALL=C sh -c ${shq(script)}`;
    if (this.sudoMode === 'root') return this.exec(cmd, opts);
    if (this.sudoMode === 'nopasswd') return this.exec(`sudo -n ${cmd}`, opts);
    if (this.sudoMode === 'password') {
      const pw = this.creds.sudoPassword || this.creds.password;
      return this.exec(`sudo -S -p '' ${cmd}`, { ...opts, stdin: `${pw}\n` });
    }
    return Promise.reject(new SshError('Mode sudo belum dideteksi', 'SUDO'));
  }

  /** Seperti root(), tapi melempar error kalau kode keluar bukan 0. */
  async rootOk(script, what) {
    const r = await this.root(script);
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
      throw new SshError(`${what} gagal (kode ${r.code})${msg ? `: ${msg}` : ''}`, 'CMD');
    }
    return r.stdout;
  }

  /**
   * Unggah isi file sebagai user SSH ke folder sementara (tanpa sudo, tanpa SFTP),
   * lalu kembalikan path-nya. Pemanggil memindahkannya dengan `install` sebagai root.
   */
  async upload(tmpDir, name, content) {
    const path = `${tmpDir}/${name}`;
    const r = await this.exec(`umask 077 && cat > ${shq(path)}`, { stdin: content, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new SshError(`Gagal mengunggah ${name}: ${r.stderr.trim()}`, 'UPLOAD');
    return path;
  }
}
