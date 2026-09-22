import json
import os
import threading
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler
import requests

# ================== CẤU HÌNH ==================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
LOCK = threading.Lock()

app = Flask(__name__)
CORS(app)  # Cho phép gọi API từ mọi domain

# ================== HÀM HỖ TRỢ ==================
def load_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config(config):
    with LOCK:
        config["system_status"]["last_updated"] = datetime.now().isoformat()
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)

def analyze_trend(history, window=10):
    """Phân tích 10 phiên gần nhất, trả về Tài/Xỉu."""
    if not history:
        return "Tài", 0
    recent = history[:window]
    tai = sum(1 for d in recent if sum(d) > 10)
    xiu = len(recent) - tai

    if tai >= 6:
        return "Xỉu", tai / len(recent)
    elif xiu >= 6:
        return "Tài", xiu / len(recent)
    else:
        last_total = sum(recent[0])
        return ("Tài" if last_total > 10 else "Xỉu"), 0.5

def fetch_game_data():
    """Thử fetch dữ liệu từ data_source_url nếu có."""
    config = load_config()
    url = config["game_info"].get("data_source_url", "").strip()
    if not url:
        return False, "Chưa cấu hình data_source_url"

    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        dice = data.get("dice") or data.get("data", {}).get("dice")
        session = data.get("session") or data.get("data", {}).get("session", "")

        if not dice or not isinstance(dice, list) or len(dice) != 3:
            return False, "Dữ liệu API không hợp lệ (cần mảng 3 xúc xắc)"

        history = config["game_info"].get("dice_history", [])
        if dice not in history:
            history.insert(0, dice)
        config["game_info"]["dice_history"] = history[:50]
        config["game_info"]["current_session"] = session
        config["game_info"]["last_result"] = "Tài" if sum(dice) > 10 else "Xỉu"

        pred, conf = analyze_trend(config["game_info"]["dice_history"])
        config["system_status"]["last_prediction"] = pred
        save_config(config)
        return True, f"Đã cập nhật phiên {session}, dự đoán: {pred}"
    except Exception as e:
        return False, f"Lỗi fetch: {str(e)}"

# ================== API ENDPOINTS ==================
@app.route("/", methods=["GET"])
def home():
    return jsonify({
        "service": "TaiXiu Prediction API",
        "status": "running",
        "endpoints": {
            "GET /api/health": "Kiểm tra trạng thái",
            "GET /api/config": "Xem cấu hình hiện tại",
            "GET /api/history": "Xem lịch sử 50 phiên",
            "GET /api/predict": "Dự đoán phiên tiếp theo",
            "POST /api/update": "Cập nhật kết quả thủ công (JSON: {dice:[...], session:\"\"})",
            "POST /api/fetch": "Fetch dữ liệu từ data_source_url",
            "POST /api/webhook": "Nhận dữ liệu từ game (JSON: {dice:[...], session:\"\"})"
        }
    })

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "time": datetime.now().isoformat()})

@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify(load_config())

@app.route("/api/history", methods=["GET"])
def get_history():
    config = load_config()
    return jsonify({
        "current_session": config["game_info"]["current_session"],
        "last_result": config["game_info"]["last_result"],
        "history": config["game_info"]["dice_history"],
        "last_prediction": config["system_status"]["last_prediction"]
    })

@app.route("/api/predict", methods=["GET"])
def predict():
    config = load_config()
    history = config["game_info"].get("dice_history", [])
    pred, conf = analyze_trend(history)
    config["system_status"]["last_prediction"] = pred
    save_config(config)
    return jsonify({
        "prediction": pred,
        "confidence": round(conf, 2),
        "based_on_sessions": len(history[:10]),
        "last_session": config["game_info"]["current_session"],
        "last_result": config["game_info"]["last_result"],
        "history": history[:10]
    })

@app.route("/api/update", methods=["POST"])
def update_manual():
    data = request.get_json(force=True, silent=True)
    if not data or "dice" not in data:
        return jsonify({"error": "Thiếu trường 'dice' (mảng 3 số)"}), 400

    dice = data["dice"]
    if not isinstance(dice, list) or len(dice) != 3:
        return jsonify({"error": "'dice' phải là mảng gồm 3 số"}), 400

    session = data.get("session", "")
    config = load_config()
    history = config["game_info"].get("dice_history", [])
    history.insert(0, dice)
    config["game_info"]["dice_history"] = history[:50]
    config["game_info"]["current_session"] = session
    config["game_info"]["last_result"] = "Tài" if sum(dice) > 10 else "Xỉu"

    pred, conf = analyze_trend(config["game_info"]["dice_history"])
    config["system_status"]["last_prediction"] = pred
    save_config(config)

    return jsonify({
        "message": "Cập nhật thành công",
        "session": session,
        "dice": dice,
        "result": config["game_info"]["last_result"],
        "next_prediction": pred,
        "confidence": round(conf, 2)
    })

@app.route("/api/fetch", methods=["POST"])
def fetch():
    ok, msg = fetch_game_data()
    return jsonify({"success": ok, "message": msg}), (200 if ok else 500)

@app.route("/api/webhook", methods=["POST"])
def webhook():
    """Dùng cho game/tool đẩy kết quả vào."""
    return update_manual()

# ================== SCHEDULER ==================
scheduler = BackgroundScheduler()
scheduler.add_job(func=fetch_game_data, trigger="interval", minutes=5)
scheduler.start()

# ================== CHẠY ==================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
