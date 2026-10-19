#!/usr/bin/env ruby
# frozen_string_literal: true

require 'socket'
require 'json'
require_relative 'build_data'

PORT = (ENV['PORT'] || 3000).to_i
PUBLIC_DIR_PATH = File.expand_path('public', __dir__)
SYNC_MUTEX = Mutex.new

MIME_TYPES = {
  '.html' => 'text/html; charset=utf-8',
  '.css'  => 'text/css; charset=utf-8',
  '.js'   => 'application/javascript; charset=utf-8',
  '.json' => 'application/json; charset=utf-8',
  '.png'  => 'image/png',
  '.svg'  => 'image/svg+xml',
  '.ico'  => 'image/x-icon'
}.freeze

def perform_safe_sync!
  SYNC_MUTEX.synchronize do
    sync_from_iddaa!
    build_full_dataset!
  end
rescue StandardError => e
  warn "Auto-sync error: #{e.message}"
  nil
end

# Başlangıçta güncel veriyi hazırla
perform_safe_sync!

# Arka planda her 60 saniyede (1 dakikada) bir otomatik güncelle
Thread.new do
  loop do
    sleep 60
    puts "⏱️ [Otomatik Güncelleme] 1 dakikalık periyodik iddaa.com senkronizasyonu çalışıyor..."
    perform_safe_sync!
  end
end

server = TCPServer.new('0.0.0.0', PORT)
puts "🚀 Yapayİddaa Sunucusu çalışıyor: http://localhost:#{PORT} (Her 60 saniyede bir otomatik güncellenir)"

loop do
  Thread.start(server.accept) do |client|
    begin
      request_line = client.gets
      next unless request_line

      method, full_path, _http_ver = request_line.split(' ')
      path = full_path.split('?').first

      # Read headers
      while (line = client.gets) && line != "\r\n"
      end

      if method == 'POST' && path == '/api/sync'
        summary = perform_safe_sync!
        body = JSON.generate({ ok: true, meta: summary })
        client.print "HTTP/1.1 200 OK\r\n" \
                     "Content-Type: application/json; charset=utf-8\r\n" \
                     "Access-Control-Allow-Origin: *\r\n" \
                     "Content-Length: #{body.bytesize}\r\n" \
                     "Connection: close\r\n\r\n" \
                     "#{body}"
      elsif method == 'GET' && path == '/api/matches'
        json_file = File.join(PUBLIC_DIR_PATH, 'matches_data.json')
        body = File.read(json_file)
        client.print "HTTP/1.1 200 OK\r\n" \
                     "Content-Type: application/json; charset=utf-8\r\n" \
                     "Access-Control-Allow-Origin: *\r\n" \
                     "Cache-Control: no-store, no-cache, must-revalidate\r\n" \
                     "Content-Length: #{body.bytesize}\r\n" \
                     "Connection: close\r\n\r\n" \
                     "#{body}"
      else
        rel_path = path == '/' ? '/index.html' : path
        safe_path = File.expand_path(".#{rel_path}", PUBLIC_DIR_PATH)

        if safe_path.start_with?(PUBLIC_DIR_PATH) && File.file?(safe_path)
          ext = File.extname(safe_path)
          content_type = MIME_TYPES[ext] || 'application/octet-stream'
          body = File.binread(safe_path)
          client.print "HTTP/1.1 200 OK\r\n" \
                       "Content-Type: #{content_type}\r\n" \
                       "Content-Length: #{body.bytesize}\r\n" \
                       "Cache-Control: no-store, no-cache, must-revalidate\r\n" \
                       "Connection: close\r\n\r\n"
          client.write(body)
        else
          not_found = '404 Not Found'
          client.print "HTTP/1.1 404 Not Found\r\n" \
                       "Content-Type: text/plain; charset=utf-8\r\n" \
                       "Content-Length: #{not_found.bytesize}\r\n" \
                       "Connection: close\r\n\r\n" \
                       "#{not_found}"
        end
      end
    rescue StandardError => e
      warn "Request error: #{e.message}"
    ensure
      client.close rescue nil
    end
  end
end
