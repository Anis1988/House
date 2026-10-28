// House PC helper: takes one screenshot of all screens and prints it as a base64 JPEG
// (max 1600 px wide). Built by install.ps1 with the C# compiler that comes with Windows.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class HouseShot {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    static int Main() {
        try {
            SetProcessDPIAware();
            Rectangle b = SystemInformation.VirtualScreen;
            using (var full = new Bitmap(b.Width, b.Height))
            using (var g = Graphics.FromImage(full)) {
                g.CopyFromScreen(b.Left, b.Top, 0, 0, full.Size);
                int w = Math.Min(1600, b.Width), h = b.Height * w / b.Width;
                using (var small = new Bitmap(full, w, h))
                using (var ms = new MemoryStream()) {
                    var jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
                    var p = new EncoderParameters(1);
                    p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
                    small.Save(ms, jpeg, p);
                    Console.Out.Write(Convert.ToBase64String(ms.ToArray()));
                }
            }
            return 0;
        } catch (Exception e) {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }
}
