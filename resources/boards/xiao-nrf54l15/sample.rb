# LED Blinking Example
while true do
  LED.set([255, 0, 0])
  sleep 1

  LED.set([0, 255, 0])
  sleep 1

  LED.set([0, 0, 255])
  sleep 1
end
