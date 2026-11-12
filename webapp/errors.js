'use strict';
/**
 * Lời giải thích lỗi cho người dùng phổ thông: "chuyện gì xảy ra" + "nên làm gì".
 * Mọi màn hình đều lấy lý do từ đây; không bao giờ hiện mã lỗi thô (vd. "unauthorized") làm nội dung chính.
 *   ErrInfo(code, status) → { reason, hint, code }
 *   ErrText(code, status) → chuỗi một dòng "lý do + cách xử lý"
 */
(function () {
  const E = {
    // --- đăng nhập / phiên ---
    unauthorized: ['Bạn chưa đăng nhập hoặc phiên đã hết hạn.', 'Hãy đăng nhập lại rồi thử lại.'],
    session_revoked: ['Phiên đăng nhập đã bị thu hồi.', 'Hãy đăng nhập lại.'],
    session_expired: ['Phiên đăng nhập đã hết hạn.', 'Hãy đăng nhập lại.'],
    account_disabled: ['Tài khoản đã bị khoá.', 'Liên hệ quản trị viên để được mở lại.'],
    forbidden: ['Bạn không có quyền thực hiện việc này.', 'Nhờ quản trị viên cấp quyền nếu cần.'],
    step_up_required: ['Cần xác thực thêm trước khi thực hiện.', 'Dùng vân tay / Face ID hoặc mã Authenticator khi được hỏi.'],
    login_step_up_required: ['Phiên đăng nhập chưa hoàn tất xác thực.', 'Đăng xuất, đăng nhập lại đầy đủ rồi thử lại.'],
    reauth_required: ['Để bảo mật, cần đăng nhập lại trước khi làm việc này.', 'Đăng xuất rồi đăng nhập lại.'],
    app_locked: ['Ứng dụng đang khoá.', 'Mở khoá bằng vân tay / mật khẩu rồi thử lại.'],
    enroll_required: ['Điều khiển đang bị khoá vì chưa bật xác thực bước hai.', 'Vào tab Điều khiển, bật vân tay / Face ID hoặc Authenticator.'],
    setup_incomplete: ['Tài khoản chưa hoàn tất thiết lập.', 'Hoàn tất các bước tạo tài khoản rồi thử lại.'],
    cancelled: ['Bạn đã huỷ thao tác.', ''],
    rate_limited: ['Bạn thao tác quá nhanh hoặc thử quá nhiều lần.', 'Đợi khoảng một phút rồi thử lại.'],
    // --- thêm thiết bị bằng QR ---
    invalid_claim_payload: ['Mã QR sai định dạng (thiếu hoặc thừa ký tự).', 'Quét lại hoặc dán đầy đủ chuỗi mã.'],
    invalid_claim_signature: ['Mã QR không hợp lệ (sai chữ ký).', 'Dùng đúng mã QR do quản trị viên hệ thống này cấp.'],
    invalid_claim_secret: ['Mã QR đã bị thay bằng mã mới, mã này không còn dùng được.', 'Xin quản trị viên mã QR mới.'],
    unknown_device: ['Thiết bị này không tồn tại trên hệ thống.', 'Nhờ quản trị viên tạo thiết bị rồi lấy mã QR.'],
    unknown_profile: ['Thiết bị này chưa được cấu hình loại.', 'Nhờ quản trị viên chọn loại thiết bị.'],
    device_already_claimed: ['Thiết bị này đã được thêm bởi tài khoản khác.', 'Chủ hiện tại cần xoá nó khỏi tài khoản của họ trước.'],
    site_taken: ['Nhà máy này đã có người khác quản lý.', 'Nhờ chủ nhà máy mời bạn làm thành viên.'],
    site_mismatch: ['Thiết bị thuộc nhà máy khác, không phải nhà máy của bạn.', ''],
    owner_has_members: ['Bạn đang là chủ một nhà máy còn thành viên khác.', 'Gỡ các thành viên trước khi thêm nhà máy mới.'],
    provision_failed: ['Máy chủ chưa tạo xong kết nối cho thiết bị.', 'Thử lại sau ít phút.'],
    no_site: ['Tài khoản chưa thuộc nhà máy nào.', 'Thêm thiết bị loại gateway (trạm chính) trước.'],
    invalid_device: ['Thông tin thiết bị trong mã QR không hợp lệ.', ''],
    invalid_site_or_device: ['Tên nhà máy / thiết bị không hợp lệ.', 'Chỉ dùng chữ, số, dấu - và _ (tối đa 48 ký tự).'],
    locked_by_provisioning: ['Lệnh này do nhà cung cấp thiết lập là nguy hiểm.', 'Không thể bỏ đánh dấu.'],
    unknown_key: ['Lệnh này không có trên thiết bị.', 'Tải lại trang rồi thử lại.'],
    invalid_activation_request: ['Mã yêu cầu từ gateway không hợp lệ (12–48 chữ và số, gồm ID máy + mã thử thách).', 'Gõ lại đúng chuỗi hiển thị trên gateway. Chữ O đọc là số 0, chữ I/L đọc là số 1.'],
    invalid_hw: ['ID máy không hợp lệ.', 'Chỉ dùng chữ và số, 4–40 ký tự.'],
    hw_required: ['Gateway phải gửi ID máy khi nạp cấu hình.', 'Cập nhật phần mềm gateway.'],
    device_already_activated: ['Thiết bị này đã được kích hoạt cho một máy khác.', 'Thu hồi thiết bị hoặc xác nhận chuyển sang máy mới.'],
    invalid_label: ['Chưa nhập tên cho token.', 'Nhập tên PC hoặc người dùng để dễ nhận biết.'],
    factory_token_invalid: ['Token nạp gateway sai hoặc đã bị thu hồi.', 'Nhờ admin cấp token mới trên trang quản trị.'],
    // --- điều khiển / thiết bị ---
    device_offline: ['Thiết bị đang mất kết nối.', 'Kiểm tra thiết bị đã bật nguồn và có mạng, rồi thử lại.'],
    not_found: ['Không tìm thấy mục này (có thể đã bị xoá).', 'Tải lại trang rồi thử lại.'],
    last_admin: ['Không thể xoá hoặc hạ quyền quản trị viên cuối cùng.', 'Hãy cấp quyền quản trị cho người khác trước.'],
    // --- quyền điều khiển (gói đăng ký) ---
    sub_pending_activation: ['Tài khoản chưa được kích hoạt gói điều khiển.', 'Nhờ quản trị viên gán gói "Giám sát + điều khiển" cho tài khoản của bạn.'],
    sub_plan_monitor_only: ['Gói hiện tại chỉ cho xem, không được điều khiển.', 'Nhờ quản trị viên nâng lên gói "Giám sát + điều khiển".'],
    sub_plan_expired: ['Gói đăng ký đã hết hạn.', 'Nhờ quản trị viên gia hạn.'],
    sub_remote_control_off: ['Điều khiển từ xa đang bị tắt cho tài khoản này.', 'Nhờ quản trị viên bật lại.'],
    sub_role: ['Vai trò của bạn chỉ được xem, không được điều khiển.', 'Nhờ quản trị viên đổi vai trò.'],
    sub_control_lan_only: ['Tài khoản chỉ được điều khiển khi ở cùng mạng nội bộ với nhà máy.', 'Kết nối Wi-Fi của nhà máy rồi thử lại.'],
    subscription_denied: ['Tài khoản không được phép điều khiển.', 'Nhờ quản trị viên kiểm tra gói đăng ký.'],
    widget_locked: ['Widget này bị khoá vì vượt giới hạn widget của gói.', 'Bấm "Nâng gói" hoặc gỡ bớt thiết bị.'],
    forbidden_gateway: ['Gateway này không thuộc tài khoản của bạn.', 'Tải lại trang rồi thử lại.'],
    remote_control_paused: ['Hệ thống đang tạm dừng điều khiển từ xa.', 'Thử lại sau ít phút.'],
    mqtt_unavailable: ['Máy chủ chưa gửi được lệnh tới thiết bị.', 'Thử lại sau ít phút.'],
    value_out_of_range: ['Giá trị nằm ngoài khoảng cho phép của thiết bị.', 'Chọn giá trị trong giới hạn hiển thị bên dưới thanh trượt.'],
    bad_command: ['Lệnh không có trên thiết bị này.', 'Tải lại trang rồi thử lại.'],
    child_id_clash: ['Gateway này có thiết bị trùng tên với gateway bạn đã thêm trong cùng nhà máy.', 'Nhờ quản trị viên đổi tên thiết bị con.'],
    // --- mạng / máy chủ ---
    network: ['Không kết nối được tới máy chủ.', 'Kiểm tra mạng Wi-Fi / 4G rồi thử lại.'],
    offline: ['Không kết nối được tới máy chủ.', 'Kiểm tra mạng Wi-Fi / 4G rồi thử lại.'],
    server_error: ['Máy chủ đang gặp sự cố.', 'Thử lại sau ít phút.'],
  };

  function ErrInfo(code, status) {
    const c = String(code || '');
    if (E[c]) return { reason: E[c][0], hint: E[c][1], code: c };
    const s = Number(status) || 0;
    if (s === 401) return { ...ErrInfo('unauthorized'), code: c || 'HTTP 401' };
    if (s === 403) return { ...ErrInfo('forbidden'), code: c || 'HTTP 403' };
    if (s === 404) return { ...ErrInfo('not_found'), code: c || 'HTTP 404' };
    if (s === 429) return { ...ErrInfo('rate_limited'), code: c || 'HTTP 429' };
    if (s >= 500) return { ...ErrInfo('server_error'), code: c || `HTTP ${s}` };
    return {
      reason: 'Thao tác chưa thực hiện được vì một lý do chưa xác định.',
      hint: 'Thử lại. Nếu vẫn lỗi, gửi mã lỗi cho quản trị viên.',
      code: c || (s ? `HTTP ${s}` : ''),
    };
  }

  const ErrText = (code, status) => {
    const i = ErrInfo(code, status);
    return i.hint ? `${i.reason} ${i.hint}` : i.reason;
  };

  window.ErrInfo = ErrInfo;
  window.ErrText = ErrText;
}());
