#pragma once
#ifndef GW_SIM
#error "gateway-mcu/sim chi dung cho ban gia lap tren PC (bien dich voi -DGW_SIM) - KHONG dung khi nap xuong board"
#endif
#include <Arduino.h>
// HTTP server tối giản (Winsock, mỗi lần một kết nối, "Connection: close") — đủ cho API LAN của firmware.
enum HTTPMethod { HTTP_ANY, HTTP_GET, HTTP_POST, HTTP_PUT };
class WebClientInfo { public: IPAddress ip; IPAddress remoteIP() const { return ip; } };
class WebServer {
 public:
  explicit WebServer(int port) : port_(port) {}
  void on(const char* path, HTTPMethod m, std::function<void()> h) { routes_.push_back({path, m, h}); }
  void onNotFound(std::function<void()> h) { notFound_ = h; }
  void collectHeaders(const char**, size_t) {}
  void begin();
  void handleClient();
  String arg(const char* name);
  String header(const char* name);
  void send(int code, const char* type, const String& body);
  WebClientInfo& client() { return client_; }
 private:
  struct Route { std::string path; HTTPMethod m; std::function<void()> h; };
  int port_;
  SOCKET ls_ = INVALID_SOCKET, cs_ = INVALID_SOCKET;
  std::vector<Route> routes_;
  std::function<void()> notFound_;
  std::map<std::string, std::string> hdr_;
  std::string body_;
  WebClientInfo client_;
  bool sent_ = false;
};
