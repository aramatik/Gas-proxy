import base64
import io
import json
import os
import random
import re
import signal
import sys
import time
from collections import deque
from pathlib import Path

import base58
import requests
from coincurve import PrivateKey
from Crypto.Cipher import AES
from Crypto.Hash import SHA256, keccak

VIEW = 1

BASE_DIR = Path(__file__).resolve().parent
RESULTS_FILE = BASE_DIR / "results.txt"
KEY_STATE_FILE = BASE_DIR / "key_usages.json"
LIVECHECK_FILE = BASE_DIR / "livecheck.txt"
PID_FILE = BASE_DIR / "tron.pid"

# =====================================================================
# 🛑 ПЕРЕХВАТЧИК КОМАНДЫ -off
# =====================================================================
if "-off" in sys.argv:
    if PID_FILE.exists():
        try:
            target_pid = int(PID_FILE.read_text().strip())
            os.kill(target_pid, signal.SIGINT)
            print(f"✅ Сигнал остановки отправлен капсуле (PID: {target_pid}).")
        except ProcessLookupError:
            print("⚠️ Процесс не найден. Возможно, капсула уже остановлена.")
        except Exception as e:
            print(f"❌ Ошибка при остановке: {e}")
        PID_FILE.unlink(missing_ok=True)
    else:
        print("⚠️ Файл tron.pid не найден. Скрипт вообще запущен?")
    sys.exit(0)
# =====================================================================

# Чтение переменных напрямую из Environment облака Northflank
TG_TOKEN = os.getenv("TG_TOKEN", "").strip()
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "").strip()
TEST_WALLET = os.getenv("TEST_WALLET", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").strip()
SEND_PRIV_KEY = os.getenv("PRIV_KEY", "1").strip() == "1"
AES_PASSPHRASE = os.getenv("AES_PASSPHRASE", "").strip()

TARGET_QPS = float(os.getenv("TARGET_QPS", 13.0))
TARGET_CYCLE = 1.0 / TARGET_QPS

raw_keys = os.getenv("API_KEYS", "")
API_KEYS = [k.strip() for k in raw_keys.split(",") if k.strip()]

USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"

session_start_time = time.time()
last_livecheck_time = time.time()
checked_count = 0
found_count = 0
current_ping_ms = 0

err_429_total = 0
window_429 = deque(maxlen=200)
exhausted_keys_in_a_row = 0

tron_http = requests.Session()
tron_http.headers.update({"Accept": "application/json", "Connection": "keep-alive"})

table_slots = ["[-] Ожидание генерации..."] * 10
needs_table_redraw = True 


def encrypt_aes_gcm(plaintext: str) -> str:
    secret = AES_PASSPHRASE if AES_PASSPHRASE else "TRON_EMERGENCY_KEY_2026"
    key = SHA256.new(secret.encode("utf-8")).digest()
    nonce = os.urandom(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext.encode("utf-8"))
    return base64.b64encode(nonce + tag + ciphertext).decode("ascii")


def generate_tron_account() -> tuple[str, str]:
    pk_bytes = os.urandom(32)
    pub_key_bytes = PrivateKey(pk_bytes).public_key.format(compressed=False)[1:]
    k_hash = keccak.new(digest_bits=256)
    k_hash.update(pub_key_bytes)
    raw_address = k_hash.digest()[-20:]
    tron_address_bytes = b"\x41" + raw_address
    b58_address = base58.b58encode_check(tron_address_bytes).decode("ascii")
    return pk_bytes.hex(), b58_address


class KeyManager:
    def __init__(self, keys: list[str], state_file: Path):
        self.keys = keys
        self.state_file = state_file
        self.limit = 99000
        # Теперь храним стату по строковым индексам "0", "1", "2" вместо самих токенов
        self.usages = {str(i): 0 for i in range(len(self.keys))}
        self.current_idx = 0
        self._load_state()

    def _load_state(self):
        if not self.state_file.exists() or not self.keys: return
        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                for k, v in data.get("usages", {}).items():
                    if k in self.usages: self.usages[k] = v
                
                # Загружаем сохраненный индекс текущего ключа
                saved_idx = data.get("current_key_idx")
                if saved_idx is not None and 0 <= int(saved_idx) < len(self.keys):
                    self.current_idx = int(saved_idx)
        except Exception: pass

    def _save_state(self):
        if not self.keys: return
        try:
            with open(self.state_file, "w", encoding="utf-8") as f:
                json.dump({
                    "current_key_idx": self.current_idx, 
                    "usages": self.usages
                }, f)
        except Exception: pass

    def force_rotate(self):
        if not self.keys: return
        self.current_idx = (self.current_idx + 1) % len(self.keys)
        self._save_state()

    def get_auth(self) -> tuple[str, str]:
        if not self.keys: return "", "Ключей нет"
        
        curr_idx_str = str(self.current_idx)

        if self.usages[curr_idx_str] >= self.limit:
            found = False
            for _ in range(len(self.keys)):
                self.current_idx = (self.current_idx + 1) % len(self.keys)
                if self.usages[str(self.current_idx)] < self.limit:
                    found = True; break
            if not found:
                for k in self.usages: self.usages[k] = 0
            curr_idx_str = str(self.current_idx)
            self._save_state()

        self.usages[curr_idx_str] += 1
        if self.usages[curr_idx_str] % 20 == 0: self._save_state()
        return self.keys[self.current_idx], f"К#{self.current_idx + 1} ({self.usages[curr_idx_str]}/{self.limit//1000}k)"


key_rotator = KeyManager(API_KEYS, KEY_STATE_FILE)


def write_livecheck(status_bar_text: str):
    elapsed = time.time() - session_start_time
    hours, rem = divmod(elapsed, 3600)
    minutes, seconds = divmod(rem, 60)
    uptime = f"{int(hours)}ч {int(minutes)}м {int(seconds)}с"
    speed = (checked_count / elapsed) if elapsed > 0 else 0.0
    timestamp_str = time.strftime('%Y-%m-%d %H:%M:%S')

    block = (
        f"==================================================\n"
        f"🟢 TRON SCANNER LIVE СHECK | {timestamp_str}\n"
        f"==================================================\n"
        f"• В работе: {uptime} | Скорость: {speed:.1f} адр/сек\n"
        f"• Найдено : {found_count} | Проверено: {checked_count}\n"
        f"--------------------------------------------------\n"
        f"[ СНЕПШОТ ЭКРАНА МАШИНЫ ]\n\n"
    )
    for slot in table_slots: block += f"{slot}\n"
    block += f"\n{status_bar_text}\n==================================================\n"

    try:
        with open(LIVECHECK_FILE, "w", encoding="utf-8") as f: f.write(block)
    except Exception: pass


def run_startup_test():
    if not TEST_WALLET: return
    print(f"[?] Проверка шлюза TronGrid...")
    api_key_str, _ = key_rotator.get_auth()
    headers = {"TRON-PRO-API-KEY": api_key_str} if api_key_str else {}

    try:
        resp = tron_http.get(f"https://api.trongrid.io/v1/accounts/{TEST_WALLET}", headers=headers, timeout=10)
        if resp.status_code != 200:
            print(f"❌ Сбой теста (HTTP {resp.status_code})\n" + "="*50 + "\n"); time.sleep(2); return
        data = resp.json()
    except Exception as e:
        print(f"❌ Ошибка сети при тесте: {e}\n" + "="*50 + "\n"); time.sleep(2); return

    accounts = data.get("data", [])
    if not accounts: return

    acc = accounts[0]
    trx = acc.get("balance", 0) / 1_000_000.0
    usdt = 0.0
    for token in acc.get("trc20", []):
        if USDT_CONTRACT in token:
            try: usdt = int(token[USDT_CONTRACT]) / 1_000_000.0
            except ValueError: pass

    print(f"✅ [ТЕСТ ПРОЙДЕН] API отвечает: {trx:g} TRX | {usdt:g} USDT\n" + "="*50 + "\n")
    time.sleep(1)


def print_hit_log(text: str):
    global needs_table_redraw
    if VIEW == 1:
        print("\r\x1b[10A\x1b[J", end=""); print(text + "\n")
        needs_table_redraw = True 
    else:
        print("\r\x1b[2K", end="", flush=True); print(text)


def send_telegram_payload(base_caption: str, pk_hex: str = None):
    if not TG_TOKEN or not TG_CHAT_ID: return
    try:
        if pk_hex is None:
            requests.post(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", 
                json={"chat_id": TG_CHAT_ID, "text": base_caption, "parse_mode": "HTML"}, timeout=10
            )
        elif SEND_PRIV_KEY:
            full_text = f"{base_caption}\nPK: <code>{pk_hex}</code>"
            requests.post(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", 
                json={"chat_id": TG_CHAT_ID, "text": full_text, "parse_mode": "HTML"}, timeout=10
            )
        else:
            cipher_key = encrypt_aes_gcm(pk_hex)
            virtual_file = io.BytesIO(cipher_key.encode('utf-8'))
            
            requests.post(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendDocument",
                data={"chat_id": TG_CHAT_ID, "caption": f"{base_caption}\n🔒 <i>Ключ зашифрован во вложении</i>", "parse_mode": "HTML"},
                files={"document": ("key.txt", virtual_file)},
                timeout=15
            )
    except Exception as e:
        print_hit_log(f"⚠️ Ошибка ТГ: {e}")


def save_hit(hit_type: str, address: str, pk: str, details: str = ""):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    # Шифруем приватный ключ методом AES-GCM перед записью в файл результатов
    encrypted_pk = encrypt_aes_gcm(pk)
    raw_payload = f"=== [{timestamp}] {hit_type} ===\nАдрес: {address}\nЗашифрованный ключ (AES-GCM): {encrypted_pk}\n{details}\n{'-'*40}\n"
    with open(RESULTS_FILE, "a", encoding="utf-8") as f:
        f.write(raw_payload)


def scan_step():
    global checked_count, found_count, needs_table_redraw, last_livecheck_time
    global err_429_total, exhausted_keys_in_a_row, current_ping_ms

    step_start_time = time.time()

    pk_hex, addr = generate_tron_account()

    if re.search(r"(.)\1{4,}", addr):
        found_count += 1
        print_hit_log(f"💎 [BEAUTY] {addr}\n🔑 Key: [ENCRYPTED]")
        save_hit("BEAUTIFUL", addr, pk_hex)
        send_telegram_payload(f"💎 <b>КРАСИВЫЙ АДРЕС Northflank</b>\nАдрес: <code>{addr}</code>", pk_hex)

    api_key_str, key_info_str = key_rotator.get_auth()
    req_headers = {"TRON-PRO-API-KEY": api_key_str} if api_key_str else {}

    try:
        resp = tron_http.get(f"https://api.trongrid.io/v1/accounts/{addr}", headers=req_headers, timeout=5)
        
        if resp.status_code == 429:
            err_429_total += 1
            window_429.append(1)
            err_density = sum(window_429)

            if err_density >= 40:
                print_hit_log(f"⚠️ [Троттлинг] Ключ #{key_rotator.current_idx + 1} забит ({err_density}/200). Проворот...")
                key_rotator.force_rotate()
                window_429.clear()
                exhausted_keys_in_a_row += 1

                if exhausted_keys_in_a_row >= len(API_KEYS):
                    send_telegram_payload("🛑 <b>АВАРИЯ</b>\nВсе ключи пула в глухом HTTP 429. Стоп.")
                    PID_FILE.unlink(missing_ok=True)
                    os._exit(1)

            time.sleep(2.0)
            return

        if resp.status_code != 200:
            time.sleep(TARGET_CYCLE)
            return

        window_429.append(0)
        if len(window_429) == 200 and sum(window_429) < 10:
            exhausted_keys_in_a_row = 0

        data = resp.json()

    except Exception:
        time.sleep(TARGET_CYCLE)
        return

    if not data.get("success", True): return

    accounts = data.get("data", [])
    is_activated = len(accounts) > 0
    trx, usdt = 0.0, 0.0

    if is_activated:
        acc = accounts[0]
        trx = acc.get("balance", 0) / 1_000_000.0
        for token in acc.get("trc20", []):
            if USDT_CONTRACT in token:
                try: usdt = int(token[USDT_CONTRACT]) / 1_000_000.0
                except ValueError: pass

    has_money = (trx > 0 or usdt > 0)

    if has_money:
        found_count += 1
        print_hit_log(f"💰 [MONEY!] {addr} -> {trx} TRX | {usdt} USDT\n🔑 Key: [ENCRYPTED]")
        save_hit("BALANCE", addr, pk_hex, f"Баланс: {trx} TRX | {usdt} USDT")
        send_telegram_payload(f"💰 <b>НАЙДЕН БАЛАНС Northflank!</b>\nАдрес: <code>{addr}</code>\nБаланс: {trx} TRX | {usdt} USDT", pk_hex)

    elif is_activated:
        found_count += 1
        print_hit_log(f"🟢 [ACTIVE] {addr} (0.0)\n🔑 Key: [ENCRYPTED]")
        save_hit("ACTIVATED", addr, pk_hex, "Баланс: 0.0")

    checked_count += 1
    
    work_duration = time.time() - step_start_time
    current_ping_ms = int(work_duration * 1000)

    elapsed = time.time() - session_start_time
    speed = (checked_count / elapsed) if elapsed > 0 else 0.0

    status_bar = f"[{speed:.1f}/с] Пров:{checked_count} | 429:{err_429_total}({sum(window_429)}/200) | Пинг:{current_ping_ms}мс | {key_info_str}"

    if VIEW == 1:
        bal_str = f"{trx:g}/{usdt:g}" if has_money else "0/0"
        short_pk = "🔐 Enc"
        raw_slot = f"[{checked_count:>5}] {addr} | {bal_str} | {short_pk}"
        table_slots[(checked_count - 1) % 10] = raw_slot[:58]

        if not needs_table_redraw: print("\r\x1b[10A", end="")
        else: needs_table_redraw = False

        for slot in table_slots: print(f"\x1b[2K{slot}")
        print(f"\x1b[2K{status_bar}", end="", flush=True)
    else:
        print(f"\r\x1b[2K{status_bar}", end="", flush=True)

    if time.time() - last_livecheck_time >= 120:
        write_livecheck(status_bar)
        last_livecheck_time = time.time()

    sleep_needed = TARGET_CYCLE - work_duration
    if sleep_needed > 0:
        time.sleep(sleep_needed * random.uniform(0.82, 1.18))


def main():
    PID_FILE.write_text(str(os.getpid()))
    print("▶️ TronScan [Northflank PaaS Edition v3.5]. Выход: Ctrl+C\n")
    run_startup_test()
    write_livecheck("Ожидание старта...")
    
    global session_start_time
    session_start_time = time.time()
    send_telegram_payload(f"▶️ Скан Tron запущен в Northflank!\nЛимит: {TARGET_QPS} QPS\nКлючей: {len(API_KEYS)}\nРежим ТГ: {'Открытый текст' if SEND_PRIV_KEY else 'Зашифрованный key.txt'}")
    
    try:
        while True: scan_step()
    except KeyboardInterrupt: print("\n🛑 Остановлено по команде.")
    except Exception as e: print(f"\n❌ Критическая ошибка: {e}")
    finally:
        key_rotator._save_state()
        PID_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
    err_density = sum(window_429)

            if err_density >= 40:
                print_hit_log(f"⚠️ [Троттлинг] Ключ #{key_rotator.current_idx + 1} забит ({err_density}/200). Проворот...")
                key_rotator.force_rotate()
                window_429.clear()
                exhausted_keys_in_a_row += 1

                if exhausted_keys_in_a_row >= len(API_KEYS):
                    send_telegram_payload("🛑 <b>АВАРИЯ</b>\nВсе ключи пула в глухом HTTP 429. Стоп.")
                    PID_FILE.unlink(missing_ok=True)
                    os._exit(1)

            time.sleep(2.0)
            return

        if resp.status_code != 200:
            time.sleep(TARGET_CYCLE)
            return

        window_429.append(0)
        if len(window_429) == 200 and sum(window_429) < 10:
            exhausted_keys_in_a_row = 0

        data = resp.json()

    except Exception:
        time.sleep(TARGET_CYCLE)
        return

    if not data.get("success", True): return

    accounts = data.get("data", [])
    is_activated = len(accounts) > 0
    trx, usdt = 0.0, 0.0

    if is_activated:
        acc = accounts[0]
        trx = acc.get("balance", 0) / 1_000_000.0
        for token in acc.get("trc20", []):
            if USDT_CONTRACT in token:
                try: usdt = int(token[USDT_CONTRACT]) / 1_000_000.0
                except ValueError: pass

    has_money = (trx > 0 or usdt > 0)

    if has_money:
        found_count += 1
        print_hit_log(f"💰 [MONEY!] {addr} -> {trx} TRX | {usdt} USDT\n🔑 Key: {pk_hex}")
        save_hit("BALANCE", addr, pk_hex, f"Баланс: {trx} TRX | {usdt} USDT")
        send_telegram_payload(f"💰 <b>НАЙДЕН БАЛАНС!</b>\nАдрес: <code>{addr}</code>\nБаланс: {trx} TRX | {usdt} USDT", pk_hex)

    elif is_activated:
        found_count += 1
        print_hit_log(f"🟢 [ACTIVE] {addr} (0.0)\n🔑 Key: {pk_hex}")
        save_hit("ACTIVATED", addr, pk_hex, "Баланс: 0.0")

    checked_count += 1
    
    work_duration = time.time() - step_start_time
    current_ping_ms = int(work_duration * 1000)

    elapsed = time.time() - session_start_time
    speed = (checked_count / elapsed) if elapsed > 0 else 0.0

    status_bar = f"[{speed:.1f}/с] Пров:{checked_count} | 429:{err_429_total}({sum(window_429)}/200) | Пинг:{current_ping_ms}мс | {key_info_str}"

    if VIEW == 1:
        bal_str = f"{trx:g}/{usdt:g}" if has_money else "0/0"
        short_pk = f"{pk_hex[:2]}..{pk_hex[-2:]}"
        raw_slot = f"[{checked_count:>5}] {addr} | {bal_str} | {short_pk}"
        table_slots[(checked_count - 1) % 10] = raw_slot[:58]

        if not needs_table_redraw: print("\r\x1b[10A", end="")
        else: needs_table_redraw = False

        for slot in table_slots: print(f"\x1b[2K{slot}")
        print(f"\x1b[2K{status_bar}", end="", flush=True)
    else:
        print(f"\r\x1b[2K{status_bar}", end="", flush=True)

    if time.time() - last_livecheck_time >= 120:
        write_livecheck(status_bar)
        last_livecheck_time = time.time()

    sleep_needed = TARGET_CYCLE - work_duration
    if sleep_needed > 0:
        time.sleep(sleep_needed * random.uniform(0.82, 1.18))


def main():
    PID_FILE.write_text(str(os.getpid()))
    print("▶️ TronScan [Northflank PaaS Edition v3.5]. Выход: Ctrl+C\n")
    run_startup_test()
    write_livecheck("Ожидание старта...")
    
    global session_start_time
    session_start_time = time.time()
    send_telegram_payload(f"▶️ Скан Tron запущен в Northflank!\nЛимит: {TARGET_QPS} QPS\nКлючей: {len(API_KEYS)}\nРежим ТГ: {'Открытый текст' if SEND_PRIV_KEY else 'Зашифрованный key.txt'}")
    
    try:
        while True: scan_step()
    except KeyboardInterrupt: print("\n🛑 Остановлено по команде.")
    except Exception as e: print(f"\n❌ Критическая ошибка: {e}")
    finally:
        key_rotator._save_state()
        PID_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
