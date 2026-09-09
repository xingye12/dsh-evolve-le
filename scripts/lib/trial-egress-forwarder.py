#!/usr/bin/env python3
"""
Retrying HTTP egress forwarder for trial containers (ADR-028 amendment,
falsification follow-up, 2026-09-06).

Replaces the `fwd` socat relay: binds the same docker-bridge address the trial
plans already point at, proxies plain-HTTP requests to the upstream proxy
(the Windows-side client behind 127.0.0.1:7897), and re-issues a 502'd or
connection-failed request up to --retries additional times with per-attempt
backoff and a fresh upstream connection per attempt. The trial container's
apt/curl/pip/uv never sees the transient 502 at all; a persistently failing
request is relayed faithfully (the final 502, or a closed connection for a
final connection failure) so client-side behavior on give-up matches the old
relay. CONNECT tunnels (HTTPS) pass through as before — no retry inside TLS,
and every observed failure is plain HTTP.

Host-side environment infrastructure (the same class as the socat relay it
replaces); NOT content-addressed into the run manifest. The retry policy is
pre-registered in docs/decisions.md (ADR-028 falsification amendment) and
pinned by --selftest below (run from scripts/tests/trial-egress-forwarder.test.ts).

Usage:
  python3 trial-egress-forwarder.py [--listen HOST:PORT] [--upstream HOST:PORT]
                                    [--retries N] [--backoff S,S,S]
  python3 trial-egress-forwarder.py --selftest
  python3 trial-egress-forwarder.py --probe-proxy http://HOST:PORT \
                                    --probe-url http://mirror/path [--probe-parallel N]
"""

import argparse
import http.client
import http.server
import socket
import socketserver
import sys
import threading
import time
import urllib.parse

DEFAULT_LISTEN = '172.17.0.1:17897'
DEFAULT_UPSTREAM = '127.0.0.1:7897'
# Setup-time apt downloads are idempotent GETs.  The formal K=80 run exposed
# 502 bursts that outlived the old 1+3 policy under a 12-way wave; retain the
# request within the 1800s setup ceiling while giving one burst time to clear.
DEFAULT_RETRIES = 8
DEFAULT_BACKOFF = (0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0, 16.0)

HOP_BY_HOP = {
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'proxy-authorization',
}


class RetryableError(Exception):
    """An idempotent request received a transient upstream response."""


RETRYABLE_HTTP_STATUS = {500, 502, 503, 504}
IDEMPOTENT_METHODS = {'GET', 'HEAD', 'OPTIONS'}


class ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    # Must be a class attribute: setting it after bind is too late to make a
    # crashed/restarted forwarder reclaim the docker0 gateway port.
    allow_reuse_address = True
    daemon_threads = True


def parse_host_port(text, label):
    host, _, port = text.rpartition(':')
    if not host or not port.isdigit():
        raise SystemExit(f'{label} must be HOST:PORT, got {text!r}')
    return host, int(port)


def probe_proxy(proxy_url, probe_url, parallel):
    """Verify an already-running forwarder before a paid evaluation wave.

    This deliberately uses the proxy's public listen address, rather than its
    upstream loopback target, so it proves the same hop that a trial container
    will use.  HEAD keeps the check reward- and task-independent.
    """
    parsed = urllib.parse.urlparse(proxy_url)
    if parsed.scheme != 'http' or not parsed.hostname or parsed.port is None:
        raise SystemExit('--probe-proxy must be an explicit http://HOST:PORT URL')
    statuses = []
    lock = threading.Lock()

    def one(index):
        try:
            conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=30)
            conn.request('HEAD', probe_url)
            response = conn.getresponse()
            response.read()
            status = response.status
            conn.close()
        except (OSError, http.client.HTTPException) as error:
            status = f'error:{type(error).__name__}'
        with lock:
            statuses.append(status)

    threads = [threading.Thread(target=one, args=(index,), daemon=True) for index in range(parallel)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ok = len(statuses) == parallel and all(isinstance(status, int) and 200 <= status < 400 for status in statuses)
    print(
        f'probe: {"OK" if ok else "FAILED"} proxy={proxy_url} parallel={parallel} statuses={statuses}',
        flush=True,
    )
    return 0 if ok else 1


class ForwarderHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'dsh-trial-egress/1'

    # Configured by the server factory before serving.
    upstream_host = '127.0.0.1'
    upstream_port = 7897
    retries = DEFAULT_RETRIES
    backoff = DEFAULT_BACKOFF

    def log_message(self, fmt, *args):
        sys.stdout.write('[fwd] ' + (fmt % args) + '\n')
        sys.stdout.flush()

    def _clean(self, headers):
        return {k: v for k, v in headers.items() if k.lower() not in HOP_BY_HOP}

    def _attempts(self):
        return 1 + self.retries

    def _fetch(self, method, url, body, headers):
        """One upstream attempt; returns (status, headers, body) or raises."""
        conn = http.client.HTTPConnection(
            self.upstream_host, self.upstream_port, timeout=60
        )
        try:
            conn.request(method, url, body=body, headers=self._clean(headers))
            resp = conn.getresponse()
            data = resp.read()
            if method in IDEMPOTENT_METHODS and resp.status in RETRYABLE_HTTP_STATUS:
                raise RetryableError(f'upstream answered HTTP {resp.status}')
            return resp.status, resp.getheaders(), data
        finally:
            conn.close()

    def _proxy(self, method):
        url = self.path
        length = int(self.headers.get('Content-Length', '0') or '0')
        body = self.rfile.read(length) if length > 0 else None
        result = None
        failure = None
        for attempt in range(self._attempts()):
            try:
                result = self._fetch(method, url, body, self.headers)
                break
            except (RetryableError, OSError, http.client.HTTPException) as error:
                failure = error
                if attempt >= self._attempts() - 1:
                    break
                delay = self.backoff[min(attempt, len(self.backoff) - 1)]
                self.log_message(
                    'retry %d/%d for %s %s: %s',
                    attempt + 1, self.retries, method, url, error,
                )
                time.sleep(delay)
        if result is None:
            if isinstance(failure, RetryableError):
                # Relay the final 502 faithfully.
                self.send_response(502)
                self.send_header('Content-Length', '0')
                self.end_headers()
            else:
                # Final connection-level failure: close without a response,
                # the same shape the socat relay produced.
                self.close_connection = True
            return
        status, headers, data = result
        self.send_response(status)
        for key, value in headers:
            low = key.lower()
            if low in HOP_BY_HOP or low == 'content-length':
                continue
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if method != 'HEAD':
            self.wfile.write(data)

    def do_GET(self):
        self._proxy('GET')

    def do_HEAD(self):
        self._proxy('HEAD')

    def do_POST(self):
        self._proxy('POST')

    def do_PUT(self):
        self._proxy('PUT')

    def do_DELETE(self):
        self._proxy('DELETE')

    def do_OPTIONS(self):
        self._proxy('OPTIONS')

    def do_CONNECT(self):
        try:
            host, port = self.path.rsplit(':', 1)
            port = int(port)
        except ValueError:
            self.send_response(400)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        upstream = socket.create_connection(
            (self.upstream_host, self.upstream_port), timeout=60
        )
        try:
            upstream.sendall(
                f'CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n'.encode()
            )
            buf = b''
            while b'\r\n\r\n' not in buf:
                chunk = upstream.recv(4096)
                if not chunk:
                    raise OSError('upstream closed during CONNECT handshake')
                buf += chunk
            head, _, rest = buf.partition(b'\r\n\r\n')
            if b' 200' not in head.split(b'\r\n')[0]:
                self.send_response(502)
                self.send_header('Content-Length', '0')
                self.end_headers()
                upstream.close()
                return
            self.send_response(200, 'Connection Established')
            self.end_headers()
            self.wfile.flush()
            if rest:
                self.connection.sendall(rest)

            def pump(source, sink):
                try:
                    while True:
                        data = source.recv(65536)
                        if not data:
                            break
                        sink.sendall(data)
                except OSError:
                    pass
                finally:
                    try:
                        sink.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass

            to_client = threading.Thread(
                target=pump, args=(upstream, self.connection), daemon=True
            )
            to_upstream = threading.Thread(
                target=pump, args=(self.connection, upstream), daemon=True
            )
            to_client.start()
            to_upstream.start()
            to_client.join()
            to_upstream.join()
        finally:
            upstream.close()
        self.close_connection = True


def make_server(listen, upstream, retries, backoff):
    handler = type(
        'ConfiguredForwarderHandler',
        (ForwarderHandler,),
        {
            'upstream_host': upstream[0],
            'upstream_port': upstream[1],
            'retries': retries,
            'backoff': backoff,
        },
    )
    return ReusableThreadingTCPServer(listen, handler)


# --- self-test (loopback only; no external network) ---------------------------


class MockUpstreamHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    counts = {}
    CONNECT_MODE = False

    def log_message(self, *_args):
        pass

    def _path(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path or self.path

    def _answer(self, path, head=False):
        MockUpstreamHandler.counts[path] = MockUpstreamHandler.counts.get(path, 0) + 1
        attempt = MockUpstreamHandler.counts[path]
        if path == '/flaky' and attempt < 3:
            body = b'<html><body>502 flaky</body></html>'
            self.send_response(502)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        if path == '/sticky':
            body = b'<html><body>502 sticky</body></html>'
            self.send_response(502)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        if path == '/connfail' and attempt == 1:
            self.close_connection = True
            self.wfile.flush()
            self.connection.close()
            return
        body = b'ok'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_GET(self):
        self._answer(self._path())

    def do_HEAD(self):
        self._answer(self._path(), head=True)

    def do_POST(self):
        self._answer(self._path())

    def do_CONNECT(self):
        host, _, port = self.path.rpartition(':')
        target = socket.create_connection((host, int(port)), timeout=10)
        try:
            self.send_response(200, 'Connection Established')
            self.end_headers()
            self.wfile.flush()

            def pump(source, sink):
                try:
                    while True:
                        data = source.recv(65536)
                        if not data:
                            break
                        sink.sendall(data)
                except OSError:
                    pass
                finally:
                    try:
                        sink.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass

            to_client = threading.Thread(
                target=pump, args=(target, self.connection), daemon=True
            )
            to_target = threading.Thread(
                target=pump, args=(self.connection, target), daemon=True
            )
            to_client.start()
            to_target.start()
            to_client.join()
            to_target.join()
        finally:
            target.close()


class MockEchoHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.rfile.readline(4096)  # request line over the tunnel
        self.wfile.write(
            b'HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nping'
        )
        self.wfile.flush()


def _selftest():
    print('selftest: starting mock upstream…')
    mock = ReusableThreadingTCPServer(('127.0.0.1', 0), MockUpstreamHandler)
    echo = ReusableThreadingTCPServer(('127.0.0.1', 0), MockEchoHandler)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    threading.Thread(target=echo.serve_forever, daemon=True).start()
    mock_port = mock.server_address[1]
    echo_port = echo.server_address[1]

    fwd = make_server(
        ('127.0.0.1', 0),
        ('127.0.0.1', mock_port),
        retries=DEFAULT_RETRIES,
        backoff=(0.01,) * DEFAULT_RETRIES,
    )
    threading.Thread(target=fwd.serve_forever, daemon=True).start()
    fwd_port = fwd.server_address[1]

    def request(path):
        conn = http.client.HTTPConnection('127.0.0.1', fwd_port, timeout=10)
        try:
            conn.request('GET', f'http://mock{path}')
            resp = conn.getresponse()
            body = resp.read()
            return resp.status, body
        finally:
            conn.close()

    failures = []

    def check(name, condition, detail):
        if not condition:
            failures.append(f'{name}: {detail}')
        print(f'selftest: {"ok" if condition else "FAIL"} {name}')

    status, body = request('/flaky')
    check(
        'flaky 502 retried to success (3 attempts)',
        status == 200 and body == b'ok' and MockUpstreamHandler.counts.get('/flaky') == 3,
        f'status={status} body={body!r} attempts={MockUpstreamHandler.counts.get("/flaky")}',
    )
    status, _body = request('/sticky')
    check(
        'persistent 502 relayed after configured attempts',
        status == 502 and MockUpstreamHandler.counts.get('/sticky') == 1 + DEFAULT_RETRIES,
        f'status={status} attempts={MockUpstreamHandler.counts.get("/sticky")}',
    )
    status, body = request('/ok')
    check(
        'healthy response passes through on the first attempt',
        status == 200 and body == b'ok' and MockUpstreamHandler.counts.get('/ok') == 1,
        f'status={status} attempts={MockUpstreamHandler.counts.get("/ok")}',
    )
    probe_result = probe_proxy(
        f'http://127.0.0.1:{fwd_port}',
        'http://mock/ok',
        parallel=2,
    )
    check(
        'parallel preflight probe reaches the forwarder listener',
        probe_result == 0 and MockUpstreamHandler.counts.get('/ok') == 3,
        f'probe={probe_result} attempts={MockUpstreamHandler.counts.get("/ok")}',
    )
    status, body = request('/connfail')
    check(
        'connection-level failure retried to success',
        status == 200 and body == b'ok' and MockUpstreamHandler.counts.get('/connfail') == 2,
        f'status={status} attempts={MockUpstreamHandler.counts.get("/connfail")}',
    )
    # A proxy may carry arbitrary candidate traffic.  Retrying POST after an
    # ambiguous upstream response could duplicate a side effect, so only the
    # idempotent apt-style methods participate in the retry policy.
    conn = http.client.HTTPConnection('127.0.0.1', fwd_port, timeout=10)
    try:
        conn.request('POST', 'http://mock/sticky', body=b'payload')
        resp = conn.getresponse()
        resp.read()
        check(
            'non-idempotent POST is not retried',
            resp.status == 502 and MockUpstreamHandler.counts.get('/sticky') == 2 + DEFAULT_RETRIES,
            f'status={resp.status} attempts={MockUpstreamHandler.counts.get("/sticky")}',
        )
    finally:
        conn.close()
    # CONNECT tunnel end-to-end.
    conn = http.client.HTTPConnection('127.0.0.1', fwd_port, timeout=10)
    try:
        conn.set_tunnel('127.0.0.1', echo_port)
        conn.request('GET', '/')
        resp = conn.getresponse()
        body = resp.read()
        check(
            'CONNECT tunnel passes bytes through',
            resp.status == 200 and body == b'ping',
            f'status={resp.status} body={body!r}',
        )
    except Exception as error:  # noqa: BLE001
        check('CONNECT tunnel passes bytes through', False, repr(error))
    finally:
        conn.close()

    mock.shutdown()
    echo.shutdown()
    fwd.shutdown()
    if failures:
        print('SELFTEST FAILED')
        return 1
    print('SELFTEST OK')
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--listen', default=DEFAULT_LISTEN)
    parser.add_argument('--upstream', default=DEFAULT_UPSTREAM)
    parser.add_argument('--retries', type=int, default=DEFAULT_RETRIES)
    parser.add_argument('--backoff', default=','.join(map(str, DEFAULT_BACKOFF)))
    parser.add_argument('--selftest', action='store_true')
    parser.add_argument('--probe-proxy')
    parser.add_argument('--probe-url')
    parser.add_argument('--probe-parallel', type=int, default=1)
    args = parser.parse_args(argv)

    if args.selftest:
        return _selftest()
    if args.probe_proxy is not None or args.probe_url is not None:
        if args.probe_proxy is None or args.probe_url is None or args.probe_parallel < 1:
            raise SystemExit('--probe-proxy and --probe-url are required; --probe-parallel must be >= 1')
        return probe_proxy(args.probe_proxy, args.probe_url, args.probe_parallel)

    listen = parse_host_port(args.listen, '--listen')
    upstream = parse_host_port(args.upstream, '--upstream')
    backoff = tuple(float(value) for value in args.backoff.split(',') if value)
    if args.retries < 0 or not backoff:
        raise SystemExit('--retries must be >= 0 and --backoff must be non-empty')
    print(
        f'[fwd] trial-egress-forwarder listening {args.listen} -> '
        f'{args.upstream} retries={args.retries} backoff={backoff}',
        flush=True,
    )
    make_server(listen, upstream, args.retries, backoff).serve_forever()
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
