from sqlalchemy import Column, String, BigInteger, DateTime
from sqlalchemy import Column, Integer, String, ForeignKey, JSON
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.sql import func
from common.database import Base


class TelegramUser(Base):
    # Tên bảng thực tế trong Database (Postgres hoặc SQLite)
    __tablename__ = "telegram_users"

    # Khóa chính: Số điện thoại (Dùng String để giữ số 0 ở đầu)
    phone_number = Column(String(20), primary_key=True)

    # ID người dùng Telegram (Dùng BigInteger vì Chat ID rất dài)
    chat_id = Column(BigInteger, nullable=False, unique=True)

    # Tự động ghi nhận thời gian đăng ký
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    def __repr__(self):
        return f"<User(phone={self.phone_number}, chat_id={self.chat_id})>"

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    email = Column(String)
    metadata_db = Column(JSON, nullable=True, default=dict)