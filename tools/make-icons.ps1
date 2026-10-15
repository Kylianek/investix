# Vyrobí ikony Investixu (plocha iPhonu, appka, záložka prohlížeče) z assets/logo.png.
# Spuštění z kořene repa:  powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
# Výsledek je v assets/icons/. Ikony jsou čtvercové a plné (iOS si zaoblení udělá sám), dům zabírá 66 % šířky.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class IconMaker
{
    public static Bitmap Load(string path)
    {
        using (Bitmap src = new Bitmap(path))
        {
            Bitmap b = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(b))
            {
                g.Clear(Color.Transparent);
                g.DrawImage(src, 0, 0, src.Width, src.Height);
            }
            return b;
        }
    }

    // Obdélník, který zabírá viditelná (neprůhledná) část loga.
    public static Rectangle Bounds(Bitmap bmp, int alphaMin)
    {
        int minX = bmp.Width, minY = bmp.Height, maxX = -1, maxY = -1;
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            byte[] buf = new byte[Math.Abs(d.Stride) * bmp.Height];
            Marshal.Copy(d.Scan0, buf, 0, buf.Length);
            for (int y = 0; y < bmp.Height; y++)
            {
                for (int x = 0; x < bmp.Width; x++)
                {
                    if (buf[y * d.Stride + x * 4 + 3] > alphaMin)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
        }
        finally
        {
            bmp.UnlockBits(d);
        }
        return new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
    }

    static Bitmap Scale(Bitmap src, int size)
    {
        Bitmap dst = new Bitmap(size, size, PixelFormat.Format32bppPArgb);
        using (Graphics g = Graphics.FromImage(dst))
        {
            g.Clear(Color.Transparent);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            using (ImageAttributes ia = new ImageAttributes())
            {
                ia.SetWrapMode(WrapMode.TileFlipXY);
                g.DrawImage(src, new Rectangle(0, 0, size, size), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, ia);
            }
        }
        return dst;
    }

    // Čtvercové okno kolem středu (cx, cy) o straně win, zmenšené na size x size po půlkách (ostré hrany).
    // opaqueWhite = plná ikona na bílém pozadí bez průhlednosti, jinak průhledné pozadí.
    public static Bitmap Render(Bitmap src, double cx, double cy, double win, int size, bool opaqueWhite)
    {
        int w = (int)Math.Round(win);
        int x0 = (int)Math.Round(cx - win / 2.0);
        int y0 = (int)Math.Round(cy - win / 2.0);
        Bitmap cur = new Bitmap(w, w, PixelFormat.Format32bppPArgb);
        using (Graphics g = Graphics.FromImage(cur))
        {
            g.Clear(Color.Transparent);
            g.DrawImage(src, new Rectangle(0, 0, w, w), new Rectangle(x0, y0, w, w), GraphicsUnit.Pixel);
        }
        while (cur.Width / 2 >= size)
        {
            Bitmap half = Scale(cur, cur.Width / 2);
            cur.Dispose();
            cur = half;
        }
        if (cur.Width != size)
        {
            Bitmap fin = Scale(cur, size);
            cur.Dispose();
            cur = fin;
        }
        if (!opaqueWhite) return cur;
        Bitmap flat = new Bitmap(size, size, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(flat))
        {
            g.Clear(Color.White);
            g.DrawImage(cur, 0, 0, size, size);
        }
        cur.Dispose();
        return flat;
    }
}
"@ -ReferencedAssemblies System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'assets/icons'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$src = [IconMaker]::Load((Join-Path $root 'assets/logo.png'))
$bounds = [IconMaker]::Bounds($src, 16)
$cx = $bounds.X + $bounds.Width / 2.0
$cy = $bounds.Y + $bounds.Height / 2.0
Write-Host ("Dům v logu: x {0}, y {1}, {2} x {3} px" -f $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)

function Save-Png($bmp, $name) {
    $path = Join-Path $out $name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("{0}  {1} B" -f $name, (Get-Item $path).Length)
}

$win = $bounds.Width / 0.66
Save-Png ([IconMaker]::Render($src, $cx, $cy, $win, 180, $true)) 'apple-touch-icon.png'
Save-Png ([IconMaker]::Render($src, $cx, $cy, $win, 192, $true)) 'icon-192.png'
Save-Png ([IconMaker]::Render($src, $cx, $cy, $win, 512, $true)) 'icon-512.png'
# záložka prohlížeče: dům větší a bez pozadí
Save-Png ([IconMaker]::Render($src, $cx, $cy, $bounds.Width / 0.92, 64, $false)) 'favicon-64.png'
# logo v hlavičce: celé plátno (stejný záběr jako původní logo.png), jen malé
Save-Png ([IconMaker]::Render($src, $src.Width / 2.0, $src.Height / 2.0, $src.Width, 96, $false)) 'logo-96.png'
$src.Dispose()
