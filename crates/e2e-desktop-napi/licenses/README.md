# Vendored license texts

Some crates the native driver links publish no license file of their own: their
license sits at the root of the repository they come from. `scripts/native/native-licenses.ts`
takes their notices from here, by the crate's repository, so the platform
packages ship the copyright and permission notice the license requires.

- `napi-rs/napi-rs/LICENSE`: from github.com/napi-rs/napi-rs at the revisions
  `napi` 3.16.3 and `napi-sys` 3.4.1 record (identical at both).
- `madsmtm/objc2/LICENSE.md`: from github.com/madsmtm/objc2 at the revisions
  `objc2`, `block2`, `dispatch2`, `objc2-encode`, and the `objc2-*` framework
  crates record (identical at each). It names the licenses but holds no
  copyright notice, so `LICENSE-MIT.txt`, `LICENSE-APACHE.txt`, and
  `LICENSE-ZLIB.txt` come from the same repository at b98d2a3e0f7b, where the
  project added the full texts.

A crate with no license file and no texts here fails the generator, never a
placeholder: add its repository's texts here after reading its license.
