// SVG Converter
// Based on tuhi's export.py JsonSvg implementation

class SVGConverter {
  constructor() {
    this.outputScalingFactor = 1000;
    this.basePenWidth = 0.4;
    this.penPressureWidthFactor = 0.2;
    this.widthPrecision = 10;
  }

  convert(drawing) {
    const width = drawing.dimensions[0] / this.outputScalingFactor;
    const height = drawing.dimensions[1] / this.outputScalingFactor;
    
    // SVG header
    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">\n`;
    svg += `  <g id="layer0">\n`;
    
    // Convert strokes
    for (let strokeIdx = 0; strokeIdx < drawing.strokes.length; strokeIdx++) {
      const stroke = drawing.strokes[strokeIdx];
      if (stroke.length === 0) continue;
      
      let path = null;
      let currentStrokeWidth = null;
      
      for (let pointIdx = 0; pointIdx < stroke.length; pointIdx++) {
        const point = stroke[pointIdx];
        const x = point.x / this.outputScalingFactor;
        const y = point.y / this.outputScalingFactor;
        
        // Calculate stroke width from pressure
        const delta = (point.p - 0x8000) / 0x8000;
        let strokeWidth = this.basePenWidth + this.penPressureWidthFactor * delta;
        
        // Reduce precision
        strokeWidth = Math.floor(strokeWidth * this.widthPrecision) / this.widthPrecision;
        
        // Convert to pixels (mm to px at 96dpi)
        const widthPx = strokeWidth * 0.26458;
        
        // Create new path if stroke width changed
        if (currentStrokeWidth !== strokeWidth) {
          if (path) {
            svg += `    ${path}\n`;
          }
          path = `<path id="sk_${strokeIdx}_${pointIdx}" style="fill:none;stroke:black;stroke-width:${widthPx.toFixed(2)}" d="M ${x.toFixed(2)} ${y.toFixed(2)}`;
          currentStrokeWidth = strokeWidth;
        } else {
          // Continue path
          path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
        }
      }
      
      // Close last path
      if (path) {
        path += '"/>';
        svg += `    ${path}\n`;
      }
    }
    
    svg += `  </g>\n`;
    svg += `</svg>\n`;
    
    return svg;
  }
}

module.exports = SVGConverter;

