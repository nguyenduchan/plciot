import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 10;

export function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

/** Hạn JWT (giờ): JWT_TTL_HOURS, mặc định 72. Đang dùng thì được gia hạn trượt (X-Renewed-Token), bỏ 3 ngày mới phải đăng nhập lại. */
export const jwtTtlSeconds = () => Math.max(1, Number(process.env.JWT_TTL_HOURS || 72)) * 3600;

export function signToken(payload, secret, expiresIn = jwtTtlSeconds()) {
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyToken(token, secret) {
  return jwt.verify(token, secret);
}

export function bearerUser(req, secret) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  try {
    return verifyToken(m[1], secret);
  } catch {
    return null;
  }
}
