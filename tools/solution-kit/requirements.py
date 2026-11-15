# -*- coding: utf-8 -*-
"""Yêu cầu BẮT BUỘC của gateway cho từng giải pháp: chỉ số (metric id) hoặc field thô ('key:<tên>') mà giao diện cần để hoạt động đúng.
Thiếu field → webapp hiện khung “Thiếu dữ liệu bắt buộc” (cùng danh sách field cần khai báo trong gateway). Lý do mỗi ngành ghi ở 'why'."""

REQ = {
    'water': (['flow', 'pressure', 'level'], 'Áp suất và mức bể là điều kiện cảnh báo vận hành (mất áp, tràn/cạn bể); lưu lượng để tính sản lượng.'),
    'agri': (['temp', 'hum', 'soil'], 'Nhiệt độ, độ ẩm khí và độ ẩm đất quyết định tưới/thông gió; thiếu một trong ba, khối vùng trồng không đánh giá được.'),
    'coldchain': (['temp'], 'Nhiệt độ kho là chỉ tiêu bắt buộc của chuỗi lạnh (HACCP): vượt ngưỡng phải báo ngay. Nên khai thêm door, comp, alarm.'),
    'hvac': (['temp', 'sp'], 'Cần nhiệt độ và giá trị cài đặt để hiển thị độ lệch theo khu vực.'),
    'factory': (['state', 'count'], 'Trạng thái máy và bộ đếm sản phẩm là nền để tính OEE; avail/perf/qual nếu có thì hiện vòng chi tiết.'),
    'energy': (['kw', 'pf', 'v1', 'i1'], 'Công suất, hệ số công suất, điện áp và dòng pha là tối thiểu để đánh giá chất lượng điện.'),
    'ev': (['state', 'kw'], 'Trạng thái trụ (rảnh/đang sạc/lỗi) và công suất để tính phiên sạc.'),
    'aqua': (['do', 'ph', 'temp'], 'Oxy hòa tan, pH, nhiệt độ là ba chỉ tiêu sống còn của ao nuôi; DO thấp phải báo ngay.'),
    'tank': (['level', 'leak'], 'Mức bồn và tín hiệu rò rỉ là yêu cầu an toàn bắt buộc với bồn xăng dầu/hóa chất.'),
    'lighting': (['dim', 'on'], 'Độ sáng và số đèn đang bật để tính tiết kiệm điện.'),
    'env': (['pm25', 'aqi'], 'PM2.5 và AQI là chỉ tiêu chính của trạm quan trắc không khí.'),
    'compressor': (['pressure', 'run'], 'Áp suất mạng khí và trạng thái máy (tải/không tải/lỗi).'),
    'facility': (['temp', 'gas'], 'Nhiệt độ và khí gas để cảnh báo cháy nổ theo vị trí; mỗi cảm biến là một thiết bị khớp vị trí trên mặt bằng (n1…n6).'),
    'process': (['la', 'lb', 'lc', 'temp', 'p1', 'p2'], 'Sơ đồ P&ID cần đủ mức 3 bồn, nhiệt độ bình và trạng thái hai bơm để vẽ dòng chảy đúng.'),
    'schedule': (['z1', 'lamp'], 'Cần trạng thái thực tế của các kênh để đối chiếu với lịch cài đặt.'),
    'elevator': (['floor', 'door'], 'Cần số tầng hiện tại (số, 1…12) và trạng thái cửa để vẽ cabin; nên khai load, fault.'),
    'fleet': (['key:lat', 'key:lon', 'state'], 'Bản đồ cần vĩ độ/kinh độ (độ thập phân, field lat và lon) và trạng thái xe.'),
    'workshop': (['state', 'parts'], 'Trạng thái máy và số chi tiết để so với kế hoạch ca (field plan).'),
    'andon': (['state', 'count', 'plan'], 'Bảng Andon cần trạng thái từng chuyền, sản lượng và kế hoạch ca.'),
    'boiler': (['wl', 'press', 'flame'], 'Mức nước, áp suất hơi và ngọn lửa là ba tín hiệu an toàn bắt buộc của lò hơi; thiếu thì không được coi là giám sát đủ điều kiện.'),
    'generator': (['src', 'run', 'fuel'], 'Nguồn đang cấp, trạng thái máy phát và nhiên liệu để biết khi mất điện còn chạy được bao lâu.'),
    'bts': (['mains', 'batt', 'key:lat', 'key:lon'], 'Trạm không người trực: phải biết mất điện lưới, mức pin và vị trí trạm.'),
    'weather': (['wd', 'ws', 'rain', 'level'], 'Hướng + tốc độ gió, lượng mưa và mực nước sông là bộ tối thiểu của trạm khí tượng thủy văn.'),
    'wwtp': (['do', 'ph', 'pump'], 'DO bể hiếu khí, pH nước ra và trạng thái bơm; vi phạm pH/COD là vi phạm xả thải.'),
    'dryer': (['temp', 'hum'], 'Nhiệt độ và độ ẩm buồng sấy để theo dõi đường cong sấy.'),
    'pumpstn': (['lvl', 'pump', 'batt'], 'Trạm chạy pin mặt trời: phải biết mức bể, bơm và mức pin để tránh bơm chạy khô.'),
}
