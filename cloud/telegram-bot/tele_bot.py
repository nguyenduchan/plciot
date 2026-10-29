import logging
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from common.database import db
from common.models import TelegramUser

import os

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
print("TELEGRAM_BOT_TOKEN: ", str(TELEGRAM_BOT_TOKEN))

async def startup(application):
    """Hàm này sẽ được chạy ngay khi Bot khởi động"""
    await db.init_db()
    print("✅ Database initialized and tables created.")

# Hàm lưu vào DB
async def save_user(phone, chat_id):
    try:
        async with db.get_session() as session:
            # 1. Kiểm tra xem User đã tồn tại chưa bằng khóa chính phone_number
            user = await session.get(TelegramUser, phone)

            if not user:
                # Tạo mới nếu chưa có
                new_user = TelegramUser(phone_number=phone, chat_id=chat_id)
                session.add(new_user)
                print(f"➕ Đã thêm user mới: {phone}")
            else:
                # Cập nhật Chat ID nếu số điện thoại đã tồn tại
                user.chat_id = chat_id
                print(f"🔄 Đã cập nhật Chat ID cho: {phone}")

            # Nếu block 'async with' hoàn tất mà không lỗi, nó sẽ tự commit
            return True

    except Exception as e:
        # Log lỗi nếu có vấn đề với Database
        print(f"❌ Lỗi khi lưu user {phone}: {e}")
        return False


# Xử lý lệnh /start
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    contact_button = KeyboardButton(text="📍 Chia sẻ số điện thoại", request_contact=True)
    reply_markup = ReplyKeyboardMarkup([[contact_button]], one_time_keyboard=True, resize_keyboard=True)

    await update.message.reply_text(
        "Chào mừng! Để nhận OTP, vui lòng nhấn nút bên dưới để xác thực số điện thoại.",
        reply_markup=reply_markup
    )


# Xử lý khi người dùng gửi contact
async def handle_contact(update: Update, context: ContextTypes.DEFAULT_TYPE):
    contact = update.message.contact
    if (update.effective_chat.type != "private" or not contact.user_id
            or not update.effective_user or contact.user_id != update.effective_user.id):
        await update.message.reply_text("Vui lòng chia sẻ số điện thoại của chính bạn trong chat riêng.")
        return
    chat_id = update.message.chat_id
    phone = contact.phone_number

    if await save_user(phone, chat_id):
        await update.message.reply_text(f"✅ Thành công! Số {phone} đã được liên kết với hệ thống.")
    else:
        await update.message.reply_text("❌ Có lỗi xảy ra, vui lòng thử lại sau.")


if __name__ == '__main__':
    application = Application.builder().token(TELEGRAM_BOT_TOKEN).post_init(startup).build()

    application.add_handler(CommandHandler("start", start))
    application.add_handler(MessageHandler(filters.CONTACT, handle_contact))

    print("Bot đang chạy...")
    application.run_polling()
