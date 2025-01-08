module ntt_common::parse {
    use wormhole::cursor;

    public macro fun parse<$T>($buf: vector<u8>, $parser: |&mut cursor::Cursor<u8>| -> $T): $T {
        let mut cur = cursor::new($buf);
        let result = $parser(&mut cur);
        cursor::destroy_empty(cur);
        result
    }
}
