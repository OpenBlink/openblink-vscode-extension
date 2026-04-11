# Generic Board Sample Code
# This demonstrates mruby/c release3.4.1 standard library functions

# Array operations
numbers = [1, 2, 3, 4, 5]
puts "Original array: #{numbers}"
puts "First element: #{numbers.first}"
puts "Last element: #{numbers.last}"
puts "Array length: #{numbers.length}"

# String operations
text = "Hello, mruby/c!"
puts "Original text: #{text}"
puts "Uppercase: #{text.upcase}"
puts "Length: #{text.length}"

# Integer operations
count = 42
puts "Number: #{count}"
puts "Even?: #{count.even?}"
puts "Absolute value: #{count.abs}"

# Hash operations
person = {name: "Alice", age: 30, city: "Tokyo"}
puts "Person data: #{person}"
puts "Name: #{person[:name]}"
puts "Keys: #{person.keys}"

# Math operations
puts "PI: #{Math::PI}"
puts "Square root of 16: #{Math.sqrt(16)}"

# Control flow
puts "\nLoop example:"
3.times do |i|
  puts "Iteration #{i + 1}"
end

puts "\nArray iteration:"
numbers.each do |num|
  puts "Number: #{num * 2}"
end

# Time operations
current_time = Time.now
puts "Current time: #{current_time.to_s}"
