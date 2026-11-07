// Skema kredensial SSH yang dipakai tambah server, pasang ulang, tes koneksi, dan copot.
export const sshSchema = {
  type: 'object',
  required: ['user', 'authMethod'],
  properties: {
    user: { type: 'string', pattern: '^[a-z_][a-z0-9_.-]{0,31}$' },
    port: { type: 'integer', minimum: 1, maximum: 65535, default: 22 },
    authMethod: { type: 'string', enum: ['password', 'key'] },
    password: { type: 'string', maxLength: 256 },
    sudoPassword: { type: 'string', maxLength: 256 },
    removeKey: { type: 'boolean', default: false }
  }
};

export const credsOf = (ssh) => ({
  authMethod: ssh.authMethod,
  password: ssh.password || null,
  sudoPassword: ssh.sudoPassword || null,
  removeKey: !!ssh.removeKey
});
