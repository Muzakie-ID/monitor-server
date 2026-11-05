import bcrypt from 'bcryptjs';
import { query } from '../db.js';

export default async function authRoutes(app) {
  app.post('/api/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: { email: { type: 'string' }, password: { type: 'string' } }
      }
    }
  }, async (req, reply) => {
    const { email, password } = req.body;
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({ error: 'Email atau kata sandi salah' });
    }
    const token = app.jwt.sign({ sub: user.id, name: user.name, role: user.role }, { expiresIn: '12h' });
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  app.get('/api/auth/me', { onRequest: [app.authenticate] }, async (req) => req.user);
}
