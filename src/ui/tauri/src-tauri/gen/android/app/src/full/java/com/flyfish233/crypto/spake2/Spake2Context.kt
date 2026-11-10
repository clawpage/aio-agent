package com.flyfish233.crypto.spake2

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.security.auth.Destroyable

// SPAKE2 over edwards25519 as adbd's wireless-debugging pairing runs it: a port of BoringSSL's
// crypto/curve25519/spake25519.cc (Apache-2.0, Copyright 2016 The BoringSSL Authors). It stands in for the
// spake2-java library Kadb is published against, which is GPL-3.0: app/build.gradle.kts leaves that library out, and
// these classes carry the names and signatures Kadb's pairing calls (Spake2Context(role, myName, theirName),
// generateMessage, processMessage, destroy). Plain BigInteger arithmetic: it runs once per pairing, not per message.

enum class Spake2Role { Alice, Bob }

class Spake2Context(private val myRole: Spake2Role, myName: ByteArray, theirName: ByteArray) : Destroyable {
  private val myName = myName.clone()
  private val theirName = theirName.clone()
  private var privateKey: BigInteger? = null
  private var passwordScalar: BigInteger? = null
  private var passwordHash = ByteArray(0)
  private var myMsg = ByteArray(0)
  private var destroyed = false

  /** This side's message (32 bytes): a random point, masked by the password times M (Alice) or N (Bob). */
  fun generateMessage(password: ByteArray): ByteArray {
    check(privateKey == null && !destroyed) { "message already generated" }
    val random = ByteArray(64).also { SecureRandom().nextBytes(it) }
    // A multiple of the cofactor (eight), so the peer's point loses any small-order part later.
    val key = le(random).mod(L).shiftLeft(3)
    passwordHash = MessageDigest.getInstance("SHA-512").digest(password)
    // BoringSSL's fix for a missing cofactor shift: multiples of the order are added until the low three bits are 0.
    var scalar = le(passwordHash).mod(L)
    if (scalar.testBit(0)) scalar = scalar.add(L)
    if (scalar.testBit(1)) scalar = scalar.add(L.shiftLeft(1))
    if (scalar.testBit(2)) scalar = scalar.add(L.shiftLeft(2))
    val mask = (if (myRole == Spake2Role.Alice) M else N).times(scalar)
    privateKey = key
    passwordScalar = scalar
    myMsg = BASE.times(key).plus(mask).encode()
    return myMsg.clone()
  }

  /** The shared key (64 bytes) from the peer's message, or null when it is not a point on the curve. */
  fun processMessage(theirMsg: ByteArray?): ByteArray? {
    val key = privateKey ?: return null
    val scalar = passwordScalar ?: return null
    if (destroyed || theirMsg == null || theirMsg.size != 32) return null
    val q = Point.decode(theirMsg) ?: return null
    val peersMask = (if (myRole == Spake2Role.Alice) N else M).times(scalar)
    val shared = q.minus(peersMask).times(key).encode()
    val sha = MessageDigest.getInstance("SHA-512")
    val add = { data: ByteArray ->
      sha.update(ByteArray(8) { i -> (data.size.toLong() shr (8 * i)).toByte() })
      sha.update(data)
    }
    if (myRole == Spake2Role.Alice) { add(myName); add(theirName); add(myMsg); add(theirMsg) }
    else { add(theirName); add(myName); add(theirMsg); add(myMsg) }
    add(shared)
    add(passwordHash)
    return sha.digest()
  }

  override fun isDestroyed() = destroyed

  override fun destroy() {
    destroyed = true
    privateKey = null
    passwordScalar = null
    passwordHash.fill(0)
  }

  /** A point of edwards25519 (-x² + y² = 1 + d·x²·y²) in affine coordinates. */
  class Point(val x: BigInteger, val y: BigInteger) {
    fun plus(o: Point): Point {
      val k = D.multiply(x).multiply(o.x).multiply(y).multiply(o.y).mod(P)
      val x3 = x.multiply(o.y).add(y.multiply(o.x)).multiply(inv(BigInteger.ONE.add(k)))
      val y3 = y.multiply(o.y).add(x.multiply(o.x)).multiply(inv(BigInteger.ONE.subtract(k)))
      return Point(x3.mod(P), y3.mod(P))
    }

    fun minus(o: Point) = plus(Point(P.subtract(o.x).mod(P), o.y))

    /** `n` times this point, for any non-negative integer `n` (no reduction: the masks are not in the prime-order subgroup). */
    fun times(n: BigInteger): Point {
      var result = IDENTITY
      for (i in n.bitLength() - 1 downTo 0) {
        result = result.plus(result)
        if (n.testBit(i)) result = result.plus(this)
      }
      return result
    }

    /** y little-endian, with x's low bit as the top bit. */
    fun encode(): ByteArray {
      val bytes = toLe(y)
      if (x.testBit(0)) bytes[31] = (bytes[31].toInt() or 0x80).toByte()
      return bytes
    }

    override fun equals(other: Any?) = other is Point && other.x == x && other.y == y
    override fun hashCode() = y.hashCode()

    companion object {
      /** As x25519_ge_frombytes_vartime: null when y has no x on the curve. */
      fun decode(bytes: ByteArray): Point? {
        val sign = (bytes[31].toInt() shr 7) and 1
        val y = le(bytes.copyOf().also { it[31] = (it[31].toInt() and 0x7f).toByte() }).mod(P)
        val y2 = y.multiply(y).mod(P)
        val u = y2.subtract(BigInteger.ONE).multiply(inv(D.multiply(y2).add(BigInteger.ONE))).mod(P)
        var x = u.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P)
        if (x.multiply(x).subtract(u).mod(P).signum() != 0) {
          x = x.multiply(SQRT_M1).mod(P)
          if (x.multiply(x).subtract(u).mod(P).signum() != 0) return null
        }
        if ((if (x.testBit(0)) 1 else 0) != sign) x = P.subtract(x).mod(P)
        return Point(x, y)
      }
    }
  }

  companion object {
    private val P: BigInteger = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19))
    /** The order of the prime-order subgroup. */
    private val L: BigInteger = BigInteger.ONE.shiftLeft(252).add(BigInteger("27742317777372353535851937790883648493"))
    private val D: BigInteger = BigInteger.valueOf(-121665).multiply(inv(BigInteger.valueOf(121666))).mod(P)
    private val SQRT_M1: BigInteger = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P)
    private val IDENTITY = Point(BigInteger.ZERO, BigInteger.ONE)
    val BASE: Point = Point.decode(hex("5866666666666666666666666666666666666666666666666666666666666666"))!!
    /** The masks of spake25519.cc, by their encodings there. */
    val M: Point = Point.decode(hex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e"))!!
    val N: Point = Point.decode(hex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778"))!!

    private fun inv(v: BigInteger): BigInteger = v.mod(P).modInverse(P)
    private fun le(bytes: ByteArray) = BigInteger(1, bytes.reversedArray())
    private fun toLe(v: BigInteger): ByteArray {
      val be = v.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
      return ByteArray(32).also { out -> be.reversedArray().copyInto(out) }
    }
    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
  }
}
