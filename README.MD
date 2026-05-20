### Booru Cache Server

#### Host

The server is hosted on a Hetzner server behind Cloudflare.

The address of the server is `https://imageproxy.vore.my`.

#### Rate Limit

- Images
  - Three times every five seconds
- Image Data
  - Three times every five seconds

Requests beyond the initial request are intended for retry logic if the initial request fails.

#### Inbound Request Requirements

Requests to the cache server will be rejected unless the requesting user agent starts with `VRChat` or `UnityPlayer`.

#### Outbound Request User Agent

The cache server sends HTTP requests with the `SkyeCA/VRCWorld/BooruBrowser` user agent.

#### Authentication

The cache server authenticates as the `BooruWorld` user.

#### Caching Details

- Images are cached with no TTL
- The server caches up to 1GB of images
 - Once the cache fills up the oldest images are deleted.
- Image details are cached a TTL of 7 days.

#### Image Processing

- All images are resized to 1920x1080 JPEGs with a quality of 80%.
- 9:16 ratio (aka vertical) images have black bars added.

### Special Tags

#### **BRI** - Booru Render Instructions

A tag that provides instructions about to to render an image to the Booru world's custom image display shader.
Use this sparingly to improve the viewing experience of photos.

Example: `BRI:Param1:Param2:Param3:Param4`

- *Param1*
  - <ins>Range:</ins> -100...100
  - <ins>Description:</ins> Brightness percentage increase or decrease over baseline.
- *Param2*
  - <ins>Range:</ins>  0...360
  - <ins>Description:</ins> Rotation of image in degrees.
- *Param3*
  - <ins>Range:</ins>  0..1
  - <ins>Description:</ins> Horizontal flip, true/false.
- *Param4*
  - <ins>Range:</ins>  0..1
  - <ins>Description:</ins> Vertical flip true/false

Notes: You must provide all parameters, simply provide a zero (0) value to those you don't need to change.

#### **side_by_side** - Stereoscopic 3D Flag

Apply this tag to stereoscopic 3D images to tell the Booru world's custom image display shader to render the image in 3D

