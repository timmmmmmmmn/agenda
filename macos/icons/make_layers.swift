// Haalt de lagen uit een plat app-icoon: de achtergrond wordt een kleurvlak in icon.json,
// de rest wordt losse lagen op een doek van 1024, zodat macOS er glas van kan maken
// (de heldere en getinte stijl van het Dock).
//
// swift make_layers.swift agenda|notities <bron.png> <map/Assets> [cijfer op de Agenda-kaart]

import AppKit

let args = CommandLine.arguments
let kind = args[1]
let src = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: args[2])))!
let out = args[3]
let w = src.pixelsWide, h = src.pixelsHigh

// Pixels als sRGB, rij 0 bovenaan.
var px = [Double](repeating: 0, count: w * h * 3)
for y in 0..<h {
  for x in 0..<w {
    let c = src.colorAt(x: x, y: y)!.usingColorSpace(.sRGB)!
    let i = (y * w + x) * 3
    px[i] = c.redComponent; px[i + 1] = c.greenComponent; px[i + 2] = c.blueComponent
  }
}
func at(_ x: Int, _ y: Int) -> (Double, Double, Double) {
  let i = (y * w + x) * 3
  return (px[i], px[i + 1], px[i + 2])
}
func dist(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
  let d = (a.0 - b.0, a.1 - b.1, a.2 - b.2)
  return (d.0 * d.0 + d.1 * d.1 + d.2 * d.2).squareRoot() * 255
}
func clamp(_ v: Double) -> Double { min(1, max(0, v)) }
func hex(_ v: UInt32) -> (Double, Double, Double) {
  (Double(v >> 16 & 255) / 255, Double(v >> 8 & 255) / 255, Double(v & 255) / 255)
}

let bg = at(8, 8)
// Hoeveel een pixel bij de voorgrond hoort (zachte rand, geen kartels).
var fg = [Double](repeating: 0, count: w * h)
var top = h, bottom = 0, left = w, right = 0
for y in 0..<h {
  for x in 0..<w {
    let a = clamp((dist(at(x, y), bg) - 18) / 50)
    fg[y * w + x] = a
    if a > 0.5 { top = min(top, y); bottom = max(bottom, y); left = min(left, x); right = max(right, x) }
  }
}

struct Layer { var name: String; var data: [UInt8] }
func newLayer(_ name: String) -> Layer { Layer(name: name, data: [UInt8](repeating: 0, count: w * h * 4)) }
func put(_ l: inout Layer, _ x: Int, _ y: Int, _ c: (Double, Double, Double), _ a: Double) {
  guard a > 0.002 else { return }
  let i = (y * w + x) * 4
  // Voorvermenigvuldigd, zoals CoreGraphics het wil.
  l.data[i] = UInt8(c.0 * a * 255); l.data[i + 1] = UInt8(c.1 * a * 255); l.data[i + 2] = UInt8(c.2 * a * 255); l.data[i + 3] = UInt8(a * 255)
}

var layers: [Layer] = []
var glyphHeight = 0.0
// Het lege witte vak onder de kop (bron-pixels), voor het cijfer.
var body: (top: Int, bottom: Int, left: Int, right: Int)? = nil

if kind == "agenda" {
  // Kaart (wit), de rode kop, en de tekst "Agenda" in de kop.
  var red = (0.0, 0.0, 0.0), n = 0.0
  var headTop = h, headBottom = 0, headLeft = w, headRight = 0
  for y in 0..<h {
    for x in 0..<w {
      let c = at(x, y)
      if c.0 > 0.55 && c.1 < 0.3 && c.2 < 0.3 {
        red.0 += c.0; red.1 += c.1; red.2 += c.2; n += 1
        headTop = min(headTop, y); headBottom = max(headBottom, y); headLeft = min(headLeft, x); headRight = max(headRight, x)
      }
    }
  }
  red = (red.0 / n, red.1 / n, red.2 / n)
  var card = newLayer("Kaart"), head = newLayer("Kop"), text = newLayer("Tekst")
  for y in 0..<h {
    for x in 0..<w {
      let a = fg[y * w + x]
      if a <= 0 { continue }
      let c = at(x, y)
      if y > headBottom - 6 {
        put(&card, x, y, (1, 1, 1), a)
      } else {
        put(&head, x, y, red, a)
        let inside = x > headLeft + 4 && x < headRight - 4 && y > headTop + 4
        let notRed = clamp(dist(c, red) / 140)
        if inside { put(&text, x, y, c, a * notRed) }
      }
    }
  }
  layers = [card, head, text]
  glyphHeight = 600
  body = (headBottom, bottom, left, right)
  print(String(format: "rood %02X%02X%02X", Int(red.0 * 255), Int(red.1 * 255), Int(red.2 * 255)))
} else {
  // Het crèmekleurige vel, en de tekst erop.
  let cream = hex(0xFBF8D3)
  var paper = newLayer("Vel"), text = newLayer("Tekst")
  for y in 0..<h {
    for x in 0..<w {
      let a = fg[y * w + x]
      if a <= 0 { continue }
      let c = at(x, y)
      put(&paper, x, y, cream, a)
      let lum = 0.3 * c.0 + 0.59 * c.1 + 0.11 * c.2
      let ink = clamp((0.93 - lum) / 0.75)
      put(&text, x, y, (0.07, 0.06, 0.05), a * ink)
    }
  }
  layers = [paper, text]
  glyphHeight = 700
}
print(String(format: "achtergrond %02X%02X%02X", Int(bg.0 * 255), Int(bg.1 * 255), Int(bg.2 * 255)))

// Elke laag op een doek van 1024, het geheel gecentreerd en groter dan op het platte icoon.
let scale = glyphHeight / Double(bottom - top + 1)
let gw = Double(right - left + 1) * scale
let originX = (1024 - gw) / 2 - Double(left) * scale
let originY = (1024 - glyphHeight) / 2 - Double(top) * scale
let space = CGColorSpace(name: CGColorSpace.sRGB)!
for layer in layers {
  var data = layer.data
  let image = data.withUnsafeMutableBytes { buf -> CGImage in
    let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return ctx.makeImage()!
  }
  let canvas = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  canvas.interpolationQuality = .high
  // CoreGraphics telt van onderen; de bron van boven.
  let rect = CGRect(x: originX, y: 1024 - originY - Double(h) * scale, width: Double(w) * scale, height: Double(h) * scale)
  canvas.draw(image, in: rect)
  let rep = NSBitmapImageRep(cgImage: canvas.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(layer.name).png"))
  print("laag \(layer.name)")
}

// Agenda: een groot cijfer in het witte vak, als eigen laag, in de letter van de datums in de app.
if let body, args.count > 4 {
  // Vanuit icons/ draaien: daar staat het lettertype.
  CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: "fonts/BarlowCondensed-Bold.ttf") as CFURL, .process, nil)
  let canvas = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  NSGraphicsContext.current = NSGraphicsContext(cgContext: canvas, flipped: false)
  // Het vak op het doek (CoreGraphics telt van onderen).
  let x0 = originX + Double(body.left) * scale, x1 = originX + Double(body.right) * scale
  let y0 = 1024 - (originY + Double(body.bottom) * scale), y1 = 1024 - (originY + Double(body.top) * scale)
  let size = (y1 - y0) * 1.02
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont(name: "BarlowCondensed-Bold", size: size) ?? NSFont.boldSystemFont(ofSize: size),
    .foregroundColor: NSColor(srgbRed: 0.07, green: 0.07, blue: 0.09, alpha: 1),
  ]
  let text = NSAttributedString(string: args[4], attributes: attrs)
  let line = CTLineCreateWithAttributedString(text)
  let glyphs = CTLineGetImageBounds(line, canvas)
  // Optisch midden: de inkt van de cijfers, niet de regelhoogte.
  let px = (x0 + x1) / 2 - glyphs.width / 2 - glyphs.minX
  let py = (y0 + y1) / 2 - glyphs.height / 2 - glyphs.minY - (y1 - y0) * 0.02
  canvas.textPosition = CGPoint(x: px, y: py)
  CTLineDraw(line, canvas)
  let rep = NSBitmapImageRep(cgImage: canvas.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/Datum.png"))
  print("laag Datum")
}
