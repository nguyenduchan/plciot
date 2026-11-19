#pragma once
// Máy chủ HTTP/HTTPS tối giản (https.cpp) cho API cài đặt của board.
#include <Arduino.h>
#include <functional>

struct HttpRequest { String method, path, body, auth; IPAddress ip; bool tls = false; };
struct HttpResponse {
  int code = 500; String type = "application/json; charset=utf-8", body = "{\"ok\":false,\"err\":\"no_response\"}";
  void json(int c, const String& b) { code = c; type = "application/json; charset=utf-8"; body = b; }
  void html(const String& b) { code = 200; type = "text/html; charset=utf-8"; body = b; }
  String serialize() const;
};

class HttpServer {
 public:
  HttpServer(int port, bool tls);
  bool begin();
  /// Nhận tối đa một kết nối (không chặn khi không có ai), đọc yêu cầu, gọi route, trả lời, đóng.
  void handle(std::function<void(const HttpRequest&, HttpResponse&)> route);
  int port() const { return port_; }
 private:
  struct Impl;
  Impl* impl_ = nullptr;
  int port_; bool tls_;
};
