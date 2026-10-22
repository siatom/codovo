//! 文件名的自然排序。
//!
//! 直接按字符串排会让 `file10` 排在 `file9` 前面（逐字符比较时 `1` < `9`），
//! 和资源管理器等文件管理器的直觉相反。这里把连续数字当成一个整数比较，
//! 其余部分仍按大小写不敏感的顺序比较。
use std::cmp::Ordering;

/// 比较两个文件名。大小写不敏感；数字段按数值大小，数值相同时前导零更少的排前面。
pub fn compare(a: &str, b: &str) -> Ordering {
    natural(a, b)
        // 把大小写不同但忽略大小写后相同的名字排成稳定顺序
        .then_with(|| a.to_lowercase().cmp(&b.to_lowercase()))
        .then_with(|| a.cmp(b))
}

/// 忽略大小写的自然比较，不处理「仅大小写不同」时的兜底顺序。
fn natural(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);

    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let start_a = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let start_b = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }

            let num_a = &a[start_a..i];
            let num_b = &b[start_b..j];
            let ord = trim_zeros(num_a)
                .len()
                .cmp(&trim_zeros(num_b).len())
                .then_with(|| trim_zeros(num_a).cmp(trim_zeros(num_b)));
            if ord != Ordering::Equal {
                return ord;
            }
            // 数值相同（1 / 01）：前导零少的排前面
            let ord = num_a.len().cmp(&num_b.len());
            if ord != Ordering::Equal {
                return ord;
            }
        } else {
            let ca = a[i].to_ascii_lowercase();
            let cb = b[j].to_ascii_lowercase();
            if ca != cb {
                return ca.cmp(&cb);
            }
            i += 1;
            j += 1;
        }
    }

    // 循环结束时至少一侧已经走完，剩下的另一方更长，因此排在后面
    i.cmp(&j)
}

/// 去掉数字段的前导零，至少保留一位（`000` 仍然按 `0` 参与比较）。
fn trim_zeros(digits: &[u8]) -> &[u8] {
    let mut start = 0;
    while start + 1 < digits.len() && digits[start] == b'0' {
        start += 1;
    }
    &digits[start..]
}

#[cfg(test)]
mod tests {
    use super::compare;
    use std::cmp::Ordering;

    #[test]
    fn orders_digit_runs_by_value() {
        assert_eq!(compare("文件9", "文件10"), Ordering::Less);
        assert_eq!(compare("file9.txt", "file10.txt"), Ordering::Less);
        assert_eq!(compare("v2", "v10"), Ordering::Less);
    }

    #[test]
    fn keeps_plain_text_order() {
        assert_eq!(compare("Alpha", "beta"), Ordering::Less);
        assert_eq!(compare("a", "a"), Ordering::Equal);
    }

    #[test]
    fn handles_leading_zeros() {
        assert_eq!(compare("file1", "file01"), Ordering::Less);
        assert_eq!(compare("file001", "file01"), Ordering::Greater);
        assert_eq!(compare("file0", "file00"), Ordering::Less);
    }

    #[test]
    fn shorter_prefix_comes_first() {
        assert_eq!(compare("file", "file1"), Ordering::Less);
        assert_eq!(compare("a1", "a1b"), Ordering::Less);
    }
}
