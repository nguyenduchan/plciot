import os
import logging
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import event
from contextlib import asynccontextmanager


class Base(DeclarativeBase):
    pass


class Database:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)

            # 1. Đọc cấu hình từ .env
            user = os.getenv("POSTGRES_USER", "postgres")
            password = os.getenv("POSTGRES_PASSWORD", "password")
            host = os.getenv("POSTGRES_HOST", "db")
            port = os.getenv("POSTGRES_PORT", "5432")
            db_name = os.getenv("POSTGRES_DB", "iot_postgres")

            db_type = os.getenv("DB_TYPE", "postgresql")  # Mặc định là postgres
            pool_size = int(os.getenv("DB_POOL_SIZE", "10"))

            # 2. Xây dựng URL kết nối
            if db_type == "postgresql":
                # Định dạng: postgresql+asyncpg://user:password@host:port/dbname
                url = f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{db_name}"

                cls._instance.engine = create_async_engine(
                    url,
                    pool_size=pool_size,
                    max_overflow=10,
                    pool_recycle=3600,
                    pool_pre_ping=True
                )
            else:
                # Lấy tên file từ biến môi trường SQLITE_DB
                sqlite_file = os.getenv("SQLITE_DB", "iot_sqlite.db")
                # Định dạng chuẩn cho aiosqlite: sqlite+aiosqlite:///filename
                url = f"sqlite+aiosqlite:///{sqlite_file}"

                cls._instance.engine = create_async_engine(url)

                # Kích hoạt chế độ WAL cho SQLite (Rất quan trọng cho đa container)
                @event.listens_for(cls._instance.engine.sync_engine, "connect")
                def set_sqlite_pragma(dbapi_connection, connection_record):
                    cursor = dbapi_connection.cursor()
                    cursor.execute("PRAGMA journal_mode=WAL")
                    cursor.execute("PRAGMA synchronous=NORMAL")
                    cursor.close()

            # 3. Khởi tạo Session Factory
            cls._instance.AsyncSessionLocal = async_sessionmaker(
                bind=cls._instance.engine,
                class_=AsyncSession,
                expire_on_commit=False
            )

        return cls._instance

    @asynccontextmanager
    async def get_session(self):
        """Sử dụng: async with db.get_session() as session:"""
        session = self.AsyncSessionLocal()
        try:
            yield session
            await session.commit()
        except Exception as e:
            await session.rollback()
            logging.error(f"Database Error: {e}")
            raise
        finally:
            await session.close()

    async def init_db(self):
        """Tạo bảng nếu chưa có"""
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)


# Instance duy nhất dùng chung cho toàn bộ container
db = Database()
