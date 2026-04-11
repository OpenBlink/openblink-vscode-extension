# M5 Stamp S3 參考文件

## LED

- `LED.set([r, g, b])` — 設定 RGB LED 顏色 (每個通道 0-255)

## GPIO

- `GPIO.set_output(pin)` — 將腳位設為輸出
- `GPIO.write(pin, value)` — 向腳位寫入 HIGH (1) 或 LOW (0)
- `GPIO.set_input(pin)` — 將腳位設為輸入
- `GPIO.read(pin)` — 讀取腳位值 (0 或 1)

## Sleep

- `sleep(seconds)` — 暫停執行指定秒數
