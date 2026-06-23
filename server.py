import http.server
import socketserver
import json
import os
import socket

PORT = 8080
STATE_FILE = 'queue_state.json'

# Helper to read state from central json file
def read_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error reading JSON state: {e}")
    return {
        "queue": [],
        "ticketCounter": 1,
        "avgWaitTimePerPerson": 5
    }

# Helper to write state to central json file
def write_state(state_data):
    try:
        with open(STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump(state_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Error writing JSON state: {e}")

class MyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/state':
            self.send_response(200)
            self.send_header('Content-type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            state_data = read_state()
            self.wfile.write(json.dumps(state_data, ensure_ascii=False).encode('utf-8'))
        else:
            # Serve static files normally
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/state':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            try:
                new_state = json.loads(post_data.decode('utf-8'))
                write_state(new_state)
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(new_state, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                self.send_response(400)
                self.send_header('Content-type', 'text/plain')
                self.end_headers()
                self.wfile.write(str(e).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't need to connect, just triggers routing interface check
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip

if __name__ == '__main__':
    local_ip = get_local_ip()
    print("==================================================")
    print(f"Takong Photobooth Server Running:")
    print(f"Local URL:  http://localhost:{PORT}")
    print(f"Mobile URL: http://{local_ip}:{PORT}")
    print("==================================================")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), MyHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
